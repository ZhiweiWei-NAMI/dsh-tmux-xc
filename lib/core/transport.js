import { spawn } from 'node:child_process';
import { XcError, CODES, isXcCode } from './errors.js';
import { validateAlias } from './quote.js';

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const NONCE_RE = /^[0-9a-f]{12}$/;

const AUTH_RE = /Permission denied/;
const HOSTKEY_RE =
  /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/;
const UNREACHABLE_RE =
  /Could not resolve hostname|Connection refused|Connection timed out|No route to host|Network is unreachable|Connection closed by|kex_exchange_identification/;

/**
 * Build the exact ssh argv from DESIGN §6. No local shell is involved, and the
 * remote program is always `sh -s` reading the script from stdin.
 *
 * @param {{ sshPath?: string, sshConfigFile?: string, connectTimeoutSec?: number }} cfg
 * @param {string} alias ssh config alias (validated)
 * @returns {string[]}
 */
export function buildSshArgv(cfg, alias) {
  if (!cfg || typeof cfg !== 'object') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'ssh config is required');
  }
  validateAlias(alias);
  const ssh = cfg.sshPath || 'ssh';
  if (typeof ssh !== 'string' || ssh.includes('\0')) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'invalid ssh path');
  }
  const connectTimeoutSec = cfg.connectTimeoutSec ?? 10;
  if (!Number.isSafeInteger(connectTimeoutSec) || connectTimeoutSec <= 0) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'connectTimeoutSec must be a positive integer');
  }
  const argv = [ssh];
  if (cfg.sshConfigFile) {
    if (typeof cfg.sshConfigFile !== 'string' || cfg.sshConfigFile.includes('\0')) {
      throw new XcError(CODES.INVALID_ARGUMENT, 'invalid sshConfigFile');
    }
    argv.push('-F', cfg.sshConfigFile);
  }
  argv.push(
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'RequestTTY=no',
    '-o', 'PermitLocalCommand=no',
    '-o', `ConnectTimeout=${connectTimeoutSec}`,
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=3',
    '--',
    alias,
    'sh -s',
  );
  return argv;
}

function defaultSpawnImpl(argv) {
  const child = spawn(argv[0], argv.slice(1), {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // EPIPE on stdin is reported through `done`; without a listener the stream
  // error would be unhandled and crash the host.
  child.stdin.on('error', () => {});
  let spawnError = null;
  const done = new Promise((resolve) => {
    child.on('error', (error) => {
      spawnError = error;
      resolve({ code: null, signal: null, error });
    });
    child.on('close', (code, signal) => resolve({ code, signal, error: spawnError }));
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    stdinWrite(str) {
      child.stdin.write(str);
      child.stdin.end();
    },
    kill() {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
    done,
  };
}

function collectStream(stream, limit) {
  return new Promise((resolve) => {
    if (!stream || typeof stream.on !== 'function') {
      resolve({ buffer: Buffer.alloc(0), overflow: false });
      return;
    }
    let buffer = Buffer.alloc(0);
    let overflow = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ buffer, overflow });
    };
    stream.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (buffer.length >= limit) {
        overflow = true;
        return;
      }
      const room = limit - buffer.length;
      if (bytes.length > room) {
        overflow = true;
        buffer = Buffer.concat([buffer, bytes.subarray(0, room)]);
      } else {
        buffer = Buffer.concat([buffer, bytes]);
      }
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  });
}

/**
 * Parse XC1 records framed with `nonce`.
 *
 *   start = "XC1" + nonce + "\x1f"
 *   sep   = "\x1f" + nonce + "\x1f"
 *   end   = "\x1e" + nonce + "\x1e\n"
 *
 * Everything outside a start..end span (banners, MOTD) is ignored. Fields may
 * contain lone \x1f / \x1e and newlines, but cannot contain the nonce-bearing
 * delimiters unless the remote already knows the per-call nonce.
 *
 * @param {string} stdout
 * @param {string} nonce
 * @returns {{ records: string[][], sawBegin: boolean, sawEnd: boolean }}
 */
export function parseRecords(stdout, nonce) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'nonce must be 12 lowercase hex characters');
  }
  const text = typeof stdout === 'string' ? stdout : '';
  const start = `XC1${nonce}\x1f`;
  const sep = `\x1f${nonce}\x1f`;
  const end = `\x1e${nonce}\x1e\n`;

  const records = [];
  let sawBegin = false;
  let sawEnd = false;
  let cursor = 0;
  for (;;) {
    const startAt = text.indexOf(start, cursor);
    if (startAt === -1) break;
    const bodyAt = startAt + start.length;
    const endAt = text.indexOf(end, bodyAt);
    if (endAt === -1) break; // incomplete trailing record: keep nothing
    const body = text.slice(bodyAt, endAt);
    const fields = body.split(sep);
    records.push(fields);
    if (fields[0] === 'begin') sawBegin = true;
    if (fields[0] === 'end') sawEnd = true;
    cursor = endAt + end.length;
  }
  return { records, sawBegin, sawEnd };
}

function stderrKind(stderr) {
  if (AUTH_RE.test(stderr)) return CODES.SSH_AUTH;
  if (HOSTKEY_RE.test(stderr)) return CODES.SSH_HOSTKEY;
  if (UNREACHABLE_RE.test(stderr)) return CODES.HOST_UNREACHABLE;
  return null;
}

function firstLine(stderr) {
  const line = String(stderr || '').split('\n', 1)[0].trim();
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

function interruptedError(mutating, reason, wrote) {
  if (mutating && wrote) {
    return new XcError(
      CODES.OUTCOME_UNKNOWN,
      'mutation interrupted; outcome unknown — verify with capture before retrying',
      { reason },
    );
  }
  if (reason === 'timeout') {
    return new XcError(CODES.TIMEOUT, 'ssh command timed out', { reason });
  }
  return new XcError(CODES.CANCELLED, 'ssh command cancelled', { reason });
}

function remoteErrRecord(records) {
  for (const rec of records) {
    if (rec[0] !== 'err') continue;
    const remoteCode = rec[1];
    const message = rec[2] ? String(rec[2]) : `remote error: ${remoteCode}`;
    const code = isXcCode(remoteCode) ? remoteCode : CODES.REMOTE_ERROR;
    return new XcError(code, message, {
      remoteCode,
      record: rec,
    });
  }
  return null;
}

function protocolError(mutating, message, details) {
  if (mutating) {
    return new XcError(
      CODES.OUTCOME_UNKNOWN,
      'mutation response was incomplete; outcome unknown — verify with capture before retrying',
      { ...details, reason: 'protocol' },
    );
  }
  return new XcError(CODES.PROTOCOL, message, details);
}

/**
 * Run one remote script over ssh.
 *
 * @param {{
 *   cfg: object,
 *   alias: string,
 *   script: string,
 *   nonce: string,
 *   mutating?: boolean,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   spawnImpl?: Function,
 * }} options
 * @returns {Promise<{ records: string[][], stderr: string, exitCode: number|null }>}
 */
export async function runRemote({
  cfg,
  alias,
  script,
  nonce,
  mutating = false,
  signal,
  timeoutMs,
  spawnImpl = defaultSpawnImpl,
} = {}) {
  if (typeof script !== 'string' || script.length === 0) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'script must be a non-empty string');
  }
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'nonce must be 12 lowercase hex characters');
  }
  if (mutating !== true && mutating !== false) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'mutating must be a boolean');
  }
  if (signal?.aborted) {
    throw new XcError(CODES.CANCELLED, 'ssh command cancelled before start');
  }
  const argv = buildSshArgv(cfg, alias);
  const effectiveTimeout = timeoutMs ?? cfg.commandTimeoutMs ?? 20000;
  if (!Number.isFinite(effectiveTimeout) || effectiveTimeout < 0) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'timeoutMs must be a non-negative number');
  }

  const attempt = async () => {
    let child;
    try {
      child = spawnImpl(argv, { stdin: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new XcError(CODES.SSH_MISSING, `ssh executable not found: ${argv[0]}`, {
          sshPath: argv[0],
        });
      }
      throw new XcError(CODES.HOST_UNREACHABLE, `failed to start ssh: ${error?.message || error}`, {
        cause: error?.code,
        sawBegin: false,
      });
    }

    const stdoutPromise = collectStream(child.stdout, MAX_STDOUT_BYTES);
    const stderrPromise = collectStream(child.stderr, MAX_STDERR_BYTES);

    let settled = false;
    let interrupted = null;
    let timer = null;
    const onAbort = () => {
      if (settled || interrupted) return;
      interrupted = 'aborted';
      child.kill();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (effectiveTimeout > 0) {
      timer = setTimeout(() => {
        if (settled || interrupted) return;
        interrupted = 'timeout';
        child.kill();
      }, effectiveTimeout);
    }

    let wrote = false;
    let writeError = null;
    try {
      if (signal?.aborted) {
        interrupted = interrupted || 'aborted';
        child.kill();
      } else {
        try {
          child.stdinWrite(script);
          wrote = true;
        } catch (error) {
          writeError = error;
          // EPIPE generally means ssh already died; make sure the child is
          // reaped rather than left half-open.
          child.kill();
        }
      }
    } finally {
      // Timers/listeners are cleaned up once `done` settles.
    }

    let outcome;
    try {
      outcome = await child.done;
    } catch (error) {
      outcome = { code: null, signal: null, error };
    } finally {
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (interrupted) {
      throw interruptedError(mutating, interrupted, wrote);
    }
    if (outcome?.error) {
      if (outcome.error.code === 'ENOENT') {
        throw new XcError(CODES.SSH_MISSING, `ssh executable not found: ${argv[0]}`, {
          sshPath: argv[0],
        });
      }
      throw new XcError(
        CODES.HOST_UNREACHABLE,
        `failed to run ssh: ${outcome.error.message || outcome.error}`,
        { cause: outcome.error.code, sawBegin: false },
      );
    }
    if (writeError) {
      if (mutating) {
        throw new XcError(
          CODES.OUTCOME_UNKNOWN,
          'failed to deliver the remote script; outcome unknown — verify with capture before retrying',
          { reason: 'stdin-write', cause: writeError.code },
        );
      }
      throw new XcError(CODES.HOST_UNREACHABLE, 'failed to deliver the remote script', {
        cause: writeError.code,
        sawBegin: false,
      });
    }

    const [{ buffer: outBuffer, overflow: stdoutOverflow }, { buffer: errBuffer }] =
      await Promise.all([stdoutPromise, stderrPromise]);
    const stdout = outBuffer.toString('utf8');
    const stderr = errBuffer.toString('utf8');
    const parsed = parseRecords(stdout, nonce);
    const exitCode = outcome?.code ?? null;
    const base = { stdout, stderr, exitCode, sawBegin: parsed.sawBegin, mutating };

    const err = remoteErrRecord(parsed.records);
    if (err) throw err;

    if (exitCode !== 0) {
      const kind = stderrKind(stderr);
      if (kind) {
        throw new XcError(kind, `ssh failed: ${firstLine(stderr) || `exit ${exitCode}`}`, {
          ...base,
          stderr,
        });
      }
      if (exitCode === 255 && !parsed.sawBegin) {
        throw new XcError(
          CODES.HOST_UNREACHABLE,
          `ssh failed: ${firstLine(stderr) || 'connection failed'}`,
          { ...base, stderr },
        );
      }
      if (!parsed.sawBegin) {
        throw protocolError(mutating, 'remote script produced no begin record', {
          ...base,
          stderr,
        });
      }
      if (!parsed.sawEnd) {
        throw protocolError(mutating, 'remote script produced no end record', {
          ...base,
          stderr,
          footer: firstLine(stderr),
        });
      }
      throw new XcError(
        CODES.REMOTE_ERROR,
        `remote script failed with exit ${exitCode}${stderr ? `: ${firstLine(stderr)}` : ''}`,
        { ...base, stderr },
      );
    }

    if (!parsed.sawBegin) {
      throw protocolError(mutating, 'remote script produced no begin record', {
        ...base,
        stderr,
        stdoutOverflow,
      });
    }
    if (!parsed.sawEnd) {
      throw protocolError(mutating, 'remote script produced no end record', {
        ...base,
        stderr,
        stdoutOverflow,
      });
    }
    const beginAt = parsed.records.findIndex((rec) => rec[0] === 'begin');
    const endAt = parsed.records.findIndex((rec, index) => index > beginAt && rec[0] === 'end');
    const records = parsed.records.slice(beginAt + 1, endAt === -1 ? undefined : endAt);
    return { records, stderr, exitCode };
  };

  try {
    return await attempt();
  } catch (error) {
    const retryable =
      !mutating &&
      error instanceof XcError &&
      error.code === CODES.HOST_UNREACHABLE &&
      error.details?.sawBegin === false &&
      !signal?.aborted;
    if (retryable) return await attempt();
    throw error;
  }
}
