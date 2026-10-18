import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { XcError, CODES } from '../../lib/core/errors.js';
import { buildSshArgv, runRemote, parseRecords } from '../../lib/core/transport.js';

const NONCE = 'a1b2c3d4e5f6';
const CFG = { sshPath: 'ssh', connectTimeoutSec: 10 };
const ALIAS = 'NaMILab';
const LOCAL_HOST = { id: 'local', transport: 'local' };

// Captured no-server framing, kept literal so this regression needs no shell,
// tmux server, or record-generation helper.
const CAPTURED_NOSERVER_OUTPUT =
  'XC1a1b2c3d4e5f6\x1fbegin\x1ea1b2c3d4e5f6\x1e\n' +
  'XC1a1b2c3d4e5f6\x1fhost\x1fa1b2c3d4e5f6\x1fmachine-id\x1fa1b2c3d4e5f6\x1f1000\x1fa1b2c3d4e5f6\x1fuser\x1ea1b2c3d4e5f6\x1e\n' +
  'XC1a1b2c3d4e5f6\x1fnoserver\x1ea1b2c3d4e5f6\x1e\n' +
  'XC1a1b2c3d4e5f6\x1fend\x1ea1b2c3d4e5f6\x1e\n';

function start(nonce = NONCE) {
  return `XC1${nonce}\x1f`;
}
function sep(nonce = NONCE) {
  return `\x1f${nonce}\x1f`;
}
function stop(nonce = NONCE) {
  return `\x1e${nonce}\x1e\n`;
}
function rec(fields, nonce = NONCE) {
  return start(nonce) + fields.join(sep(nonce)) + stop(nonce);
}
function okOutput(records = [], nonce = NONCE) {
  return (
    'MOTD banner\n' +
    rec(['begin'], nonce) +
    records.map((fields) => rec(fields, nonce)).join('') +
    rec(['end'], nonce) +
    'trailing banner\n'
  );
}

function hostRecord(nonce = NONCE) {
  return rec(['host', 'machine-id', '1000', 'user'], nonce);
}

/**
 * Fake spawnImpl. Each element of `plan` describes one spawned child.
 */
function fakeSpawn(plan) {
  const calls = [];
  let index = 0;
  const spawnImpl = (argv, options) => {
    const step = plan[Math.min(index, plan.length - 1)];
    index += 1;
    const out = new PassThrough();
    const err = new PassThrough();
    let resolveDone;
    let settled = false;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const child = {
      argv,
      options,
      stdout: out,
      done,
      stderr: err,
      writes: [],
      kills: 0,
      stdinWrite(text) {
        child.writes.push(text);
        if (step.writeThrows) {
          // EPIPE: the child is already gone; `done` still resolves with the
          // signal, but no exit code.
          queueMicrotask(() => child.finish({ code: null, signal: 'EPIPE' }));
          const error = new Error('write EPIPE');
          error.code = 'EPIPE';
          throw error;
        }
        if (step.onWrite) step.onWrite(child);
      },
      kill() {
        child.kills += 1;
        if (step.onKill) step.onKill(child);
      },
      finish({ code = 0, signal = null, error = null, stdout = '', stderr = '' } = {}) {
        if (settled) return;
        settled = true;
        if (stdout) out.write(stdout);
        if (stderr) err.write(stderr);
        out.end();
        err.end();
        resolveDone({ code, signal, error });
      },
    };
    calls.push(child);
    return child;
  };
  return { spawnImpl, calls };
}

// Resolve on a macrotask: the transport must have awaited `done` before the
// child reports its exit status.
function succeed(stdout, { code = 0, stderr = '', onWrite } = {}) {
  return {
    onWrite: onWrite ?? ((child) => queueMicrotask(() => child.finish({ code, stdout, stderr }))),
  };
}

function fail({ code = 255, stderr = '', stdout = '', onWrite }) {
  return {
    onWrite: onWrite ?? ((child) => queueMicrotask(() => child.finish({ code, stdout, stderr }))),
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof XcError, `expected XcError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test('buildSshArgv produces the exact DESIGN §6 argv', () => {
  assert.deepEqual(buildSshArgv(CFG, ALIAS), [
    'ssh',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'RequestTTY=no',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=3',
    '--',
    'NaMILab',
    'sh -s',
  ]);
});

test('buildSshArgv honours sshPath, sshConfigFile and connectTimeoutSec', () => {
  const argv = buildSshArgv(
    { sshPath: 'C:\\Windows\\ssh.exe', sshConfigFile: '/tmp/ssh_config', connectTimeoutSec: 3 },
    'host.example.com',
  );
  assert.equal(argv[0], 'C:\\Windows\\ssh.exe');
  assert.deepEqual(argv.slice(1, 3), ['-F', '/tmp/ssh_config']);
  assert.ok(argv.includes('ConnectTimeout=3'));
  assert.deepEqual(argv.slice(-3), ['--', 'host.example.com', 'sh -s']);
  assert.equal(argv.includes('StrictHostKeyChecking=no'), false);
  assert.equal(argv.some((a) => /UserKnownHostsFile/.test(a)), false);
  assert.equal(argv.includes('-A'), false);
});

test('buildSshArgv rejects invalid aliases/timeouts instead of interpolating', () => {
  assert.throws(() => buildSshArgv(CFG, '-oProxyCommand=evil'), { code: CODES.INVALID_ARGUMENT });
  assert.throws(() => buildSshArgv(CFG, 'a b'), { code: CODES.INVALID_ARGUMENT });
  assert.throws(() => buildSshArgv({ ...CFG, connectTimeoutSec: 0 }, ALIAS), {
    code: CODES.INVALID_ARGUMENT,
  });
});

test('buildSshArgv uses only sh -s for local hosts and ignores ssh configuration', () => {
  assert.deepEqual(buildSshArgv(CFG, undefined, LOCAL_HOST), ['sh', '-s']);
  assert.deepEqual(buildSshArgv({
    sshPath: '/unused/ssh',
    sshConfigFile: '/unused/config',
    connectTimeoutSec: 0,
  }, '-invalid alias', { ...LOCAL_HOST, ssh: '-also ignored' }), ['sh', '-s']);
});

test('buildSshArgv defaults the ssh alias to host.ssh', () => {
  assert.deepEqual(
    buildSshArgv(CFG, undefined, { ssh: ALIAS }),
    buildSshArgv(CFG, ALIAS),
  );
});

test('runRemote accepts a config host while retaining the legacy alias option', async () => {
  for (const host of [LOCAL_HOST, { ssh: ALIAS }, { transport: 'ssh', ssh: ALIAS }]) {
    const { spawnImpl, calls } = fakeSpawn([succeed(okOutput([['ok']]))]);
    const result = await runRemote({ cfg: CFG, host, script: 'x', nonce: NONCE, spawnImpl });
    assert.deepEqual(calls[0].argv, host.transport === 'local' ? ['sh', '-s'] : buildSshArgv(CFG, ALIAS));
    assert.deepEqual(calls[0].writes, ['x']);
    assert.deepEqual(result.records, [['ok']]);
  }
});

test('captured noserver output parses and returns noserver without PROTOCOL', async () => {
  const parsed = parseRecords(CAPTURED_NOSERVER_OUTPUT, NONCE);
  assert.equal(parsed.sawBegin, true);
  assert.equal(parsed.sawEnd, true);
  assert.deepEqual(parsed.records, [
    ['begin'], ['host', 'machine-id', '1000', 'user'], ['noserver'], ['end'],
  ]);
  for (const options of [{ alias: ALIAS }, { host: LOCAL_HOST }]) {
    const { spawnImpl } = fakeSpawn([succeed(CAPTURED_NOSERVER_OUTPUT)]);
    const result = await runRemote({ cfg: CFG, ...options, script: 'x', nonce: NONCE, spawnImpl });
    assert.deepEqual(result.records, [['host', 'machine-id', '1000', 'user'], ['noserver']]);
  }
});

test('runRemote writes the script to stdin and returns parsed records', async () => {
  const { spawnImpl, calls } = fakeSpawn([succeed(okOutput([['host', 'm', '1000', 'u'], ['ok', '$3']]))]);
  const result = await runRemote({
    cfg: CFG,
    alias: ALIAS,
    script: 'printf hi\n',
    nonce: NONCE,
    mutating: false,
    spawnImpl,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, buildSshArgv(CFG, ALIAS));
  assert.deepEqual(calls[0].options, { stdin: true });
  assert.deepEqual(calls[0].writes, ['printf hi\n']);
  assert.deepEqual(result.records, [['host', 'm', '1000', 'u'], ['ok', '$3']]);
  assert.equal(result.exitCode, 0);
  assert.equal(typeof result.stderr, 'string');
});

test('runRemote ignores banners outside records and reports empty record list', async () => {
  const { spawnImpl } = fakeSpawn([succeed(okOutput([]))]);
  const result = await runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl });
  assert.deepEqual(result.records, []);
});

test('runRemote maps ssh exit 255 without begin to HOST_UNREACHABLE', async () => {
  const { spawnImpl } = fakeSpawn([fail({ code: 255, stderr: 'ssh: connect to host x port 22: Connection refused\n' })]);
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, mutating: false, spawnImpl }),
    CODES.HOST_UNREACHABLE,
  );
});

test('runRemote classifies auth and host-key stderr', async () => {
  const auth = fakeSpawn([fail({ code: 255, stderr: 'user@host: Permission denied (publickey).\n' })]);
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl: auth.spawnImpl }),
    CODES.SSH_AUTH,
  );
  const hostkey = fakeSpawn([
    fail({ code: 255, stderr: '@@@ REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\n' }),
  ]);
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl: hostkey.spawnImpl }),
    CODES.SSH_HOSTKEY,
  );
  const unknown = fakeSpawn([fail({ code: 255, stderr: 'No RSA host key is known for host.\n' })]);
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl: unknown.spawnImpl }),
    CODES.SSH_HOSTKEY,
  );
});

test('runRemote classifies kex/route/dns failures as HOST_UNREACHABLE', async () => {
  for (const stderr of [
    'ssh: Could not resolve hostname nope: Name or service not known\n',
    'No route to host\n',
    'Network is unreachable\n',
    'Connection closed by 10.0.0.1 port 22\n',
    'kex_exchange_identification: read: Connection reset by peer\n',
  ]) {
    const { spawnImpl } = fakeSpawn([fail({ code: 255, stderr })]);
    await expectCode(
      runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl }),
      CODES.HOST_UNREACHABLE,
    );
  }
});

test('local nonzero exits without end remain protocol failures, never ssh errors or retries', async () => {
  for (const stderr of [
    'Permission denied (publickey).\n',
    'Host key verification failed.\n',
    'Connection refused\n',
  ]) {
    for (const code of [1, 255]) {
      for (const stdout of [
        '',
        rec(['begin']),
        rec(['begin']) + rec(['err', CODES.REMOTE_ERROR, 'partial error']),
        rec(['begin']) + rec(['err', CODES.TARGET_GONE, 'partial error']),
      ]) {
        for (const mutating of [false, true]) {
          const { spawnImpl, calls } = fakeSpawn([fail({ code, stdout, stderr })]);
          await expectCode(runRemote({
            cfg: CFG, host: LOCAL_HOST, script: 'x', nonce: NONCE, mutating, spawnImpl,
          }), mutating ? CODES.OUTCOME_UNKNOWN : CODES.PROTOCOL);
          assert.equal(calls.length, 1);
        }
      }
    }
  }
});

test('local nonzero exits with complete framing are REMOTE_ERROR despite ssh-like stderr', async () => {
  const { spawnImpl } = fakeSpawn([
    succeed(okOutput([]), { code: 255, stderr: 'Permission denied\n' }),
  ]);
  await expectCode(runRemote({
    cfg: CFG, host: LOCAL_HOST, script: 'x', nonce: NONCE, spawnImpl,
  }), CODES.REMOTE_ERROR);
});

test('local sh spawn ENOENT maps to SSH_MISSING for synchronous and asynchronous failures', async () => {
  const error = Object.assign(new Error('spawn sh ENOENT'), { code: 'ENOENT' });
  const asyncFailure = fakeSpawn([{
    onWrite: (child) => queueMicrotask(() => child.finish({ code: null, error })),
  }]);
  for (const spawnImpl of [() => { throw error; }, asyncFailure.spawnImpl]) {
    await expectCode(runRemote({
      cfg: CFG, host: LOCAL_HOST, script: 'x', nonce: NONCE, spawnImpl,
    }), CODES.SSH_MISSING);
  }
  assert.deepEqual(asyncFailure.calls[0].argv, ['sh', '-s']);
});

test('runRemote reports SSH_MISSING when ssh cannot be spawned (ENOENT)', async () => {
  const { spawnImpl } = fakeSpawn([
    {
      onWrite: () => {},
    },
  ]);
  const childErrorSpawn = (argv, options) => {
    const out = new PassThrough();
    const err = new PassThrough();
    out.end();
    err.end();
    return {
      stdout: out,
      stderr: err,
      stdinWrite() {},
      kill() {},
      done: Promise.resolve({
        code: null,
        signal: null,
        error: Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }),
      }),
    };
  };
  assert.equal(typeof spawnImpl, 'function');
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl: childErrorSpawn }),
    CODES.SSH_MISSING,
  );
});

test('runRemote never retries a mutating script on host failure', async () => {
  const { spawnImpl, calls } = fakeSpawn([fail({ code: 255, stderr: 'Connection refused\n' })]);
  await expectCode(
    runRemote({
      cfg: CFG,
      alias: ALIAS,
      script: 'x',
      nonce: NONCE,
      mutating: true,
      spawnImpl,
    }),
    CODES.HOST_UNREACHABLE,
  );
  assert.equal(calls.length, 1);
});

test('runRemote retries a read-only script once after failing before begin', async () => {
  const { spawnImpl, calls } = fakeSpawn([
    fail({ code: 255, stderr: 'Connection refused\n' }),
    succeed(okOutput([['ok']])),
  ]);
  const result = await runRemote({
    cfg: CFG,
    alias: ALIAS,
    script: 'x',
    nonce: NONCE,
    mutating: false,
    spawnImpl,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.records, [['ok']]);
});

test('runRemote retries a read-only script at most once', async () => {
  const { spawnImpl, calls } = fakeSpawn([
    fail({ code: 255, stderr: 'Connection refused\n' }),
    fail({ code: 255, stderr: 'Connection refused\n' }),
    succeed(okOutput([])),
  ]);
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl }),
    CODES.HOST_UNREACHABLE,
  );
  assert.equal(calls.length, 2);
});

test('runRemote does not retry after begin was seen', async () => {
  const partial = rec(['begin']) + 'banner\n';
  const { spawnImpl, calls } = fakeSpawn([
    fail({ code: 255, stderr: 'Connection closed by host\n', stdout: partial }),
    succeed(okOutput([])),
  ]);
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl }),
    CODES.HOST_UNREACHABLE,
  );
  assert.equal(calls.length, 1);
});

test('missing end record → PROTOCOL for read-only, OUTCOME_UNKNOWN for mutating', async () => {
  const stdout = rec(['begin']) + rec(['ok', '$3']);
  const readOnly = fakeSpawn([succeed(stdout)]);
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl: readOnly.spawnImpl }),
    CODES.PROTOCOL,
  );
  const mutating = fakeSpawn([succeed(stdout)]);
  await expectCode(
    runRemote({
      cfg: CFG,
      alias: ALIAS,
      script: 'x',
      nonce: NONCE,
      mutating: true,
      spawnImpl: mutating.spawnImpl,
    }),
    CODES.OUTCOME_UNKNOWN,
  );
});

test('missing begin record → PROTOCOL for read-only, OUTCOME_UNKNOWN for mutating', async () => {
  const readOnly = fakeSpawn([succeed('nothing here\n')]);
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl: readOnly.spawnImpl }),
    CODES.PROTOCOL,
  );
  const mutating = fakeSpawn([succeed('nothing here\n')]);
  await expectCode(
    runRemote({
      cfg: CFG,
      alias: ALIAS,
      script: 'x',
      nonce: NONCE,
      mutating: true,
      spawnImpl: mutating.spawnImpl,
    }),
    CODES.OUTCOME_UNKNOWN,
  );
});

test('err records followed by end preserve their XcError code and message', async () => {
  for (const code of [CODES.TARGET_GONE, CODES.REMOTE_ERROR, CODES.REMOTE_TOOL_MISSING]) {
    for (const options of [{ alias: ALIAS }, { host: LOCAL_HOST }]) {
      for (const mutating of [false, true]) {
        for (const exitCode of [0, 1, 255]) {
          const record = ['err', code, 'remote failure detail'];
          const { spawnImpl } = fakeSpawn([succeed(okOutput([record]), { code: exitCode })]);
          await assert.rejects(runRemote({
            cfg: CFG, ...options, script: 'x', nonce: NONCE, mutating, spawnImpl,
          }), (error) => {
            assert.ok(error instanceof XcError);
            assert.equal(error.code, code);
            assert.equal(error.message, 'remote failure detail');
            assert.deepEqual(error.details.record, record);
            return true;
          });
        }
      }
    }
  }
});

test('an err record without a message retains the default remote error message', async () => {
  const { spawnImpl } = fakeSpawn([succeed(okOutput([['err', CODES.REMOTE_TOOL_MISSING]]))]);
  await assert.rejects(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl }),
    { code: CODES.REMOTE_TOOL_MISSING, message: 'remote error: REMOTE_TOOL_MISSING' },
  );
});

test('an unknown err code falls back to REMOTE_ERROR', async () => {
  const { spawnImpl } = fakeSpawn([succeed(okOutput([['err', 'NOPE', 'boom']]))]);
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl }),
    CODES.REMOTE_ERROR,
  );
});

test('timeout kills the child; mutating reports OUTCOME_UNKNOWN, read-only TIMEOUT', async () => {
  const hanging = (child) => {
    child.finish = undefined;
  };
  const makeHang = () =>
    fakeSpawn([
      {
        onWrite: () => {},
        onKill: (child) => setImmediate(() => child.finish({ code: null, signal: 'SIGTERM' })),
      },
    ]);
  assert.equal(typeof hanging, 'function');

  const readOnly = makeHang();
  await expectCode(
    runRemote({
      cfg: CFG,
      alias: ALIAS,
      script: 'x',
      nonce: NONCE,
      timeoutMs: 25,
      spawnImpl: readOnly.spawnImpl,
    }),
    CODES.TIMEOUT,
  );
  assert.equal(readOnly.calls[0].kills, 1);

  const mutating = makeHang();
  await expectCode(
    runRemote({
      cfg: CFG,
      alias: ALIAS,
      script: 'x',
      nonce: NONCE,
      mutating: true,
      timeoutMs: 25,
      spawnImpl: mutating.spawnImpl,
    }),
    CODES.OUTCOME_UNKNOWN,
  );
  assert.equal(mutating.calls[0].kills, 1);
});

test('abort before spawn rejects CANCELLED without spawning, including mutations', async () => {
  for (const options of [{ alias: ALIAS }, { host: LOCAL_HOST }]) {
    for (const mutating of [false, true]) {
      const controller = new AbortController();
      controller.abort();
      const { spawnImpl, calls } = fakeSpawn([succeed(okOutput([]))]);
      await expectCode(
        runRemote({
          cfg: CFG,
          ...options,
          script: 'x',
          nonce: NONCE,
          mutating,
          signal: controller.signal,
          spawnImpl,
        }),
        CODES.CANCELLED,
      );
      assert.equal(calls.length, 0);
    }
  }
});

test('abort after write is CANCELLED for read-only and OUTCOME_UNKNOWN for mutating', async () => {
  const makeAbortable = () => {
    const controller = new AbortController();
    const holder = { controller };
    const fake = fakeSpawn([
      {
        onWrite: () => {},
        onKill: (child) => setImmediate(() => child.finish({ code: null, signal: 'SIGTERM' })),
      },
    ]);
    holder.fake = fake;
    return holder;
  };

  const readOnly = makeAbortable();
  setTimeout(() => readOnly.controller.abort(), 5);
  await expectCode(
    runRemote({
      cfg: CFG,
      alias: ALIAS,
      script: 'x',
      nonce: NONCE,
      signal: readOnly.controller.signal,
      spawnImpl: readOnly.fake.spawnImpl,
    }),
    CODES.CANCELLED,
  );
  assert.equal(readOnly.fake.calls.length, 1);
  assert.equal(readOnly.fake.calls[0].kills, 1);

  const mutating = makeAbortable();
  setTimeout(() => mutating.controller.abort(), 5);
  await expectCode(
    runRemote({
      cfg: CFG,
      alias: ALIAS,
      script: 'x',
      nonce: NONCE,
      mutating: true,
      signal: mutating.controller.signal,
      spawnImpl: mutating.fake.spawnImpl,
    }),
    CODES.OUTCOME_UNKNOWN,
  );
});

test('synchronous spawn abort is OUTCOME_UNKNOWN for mutations, without writing or replaying', async () => {
  for (const options of [{ alias: ALIAS }, { host: LOCAL_HOST }]) {
    for (const mutating of [false, true]) {
      const controller = new AbortController();
      const fake = fakeSpawn([{
        onKill: (child) => child.finish({ code: null, signal: 'SIGTERM' }),
      }]);
      const spawnImpl = (argv, spawnOptions) => {
        const child = fake.spawnImpl(argv, spawnOptions);
        // Abort before runRemote installs its listener or writes stdin.
        controller.abort();
        return child;
      };
      await assert.rejects(runRemote({
        cfg: CFG,
        ...options,
        script: 'tmux send-keys -t %7 Enter\n',
        nonce: NONCE,
        mutating,
        signal: controller.signal,
        spawnImpl,
      }), (error) => {
        assert.ok(error instanceof XcError);
        assert.equal(error.code, mutating ? CODES.OUTCOME_UNKNOWN : CODES.CANCELLED);
        assert.equal(error.details.reason, 'aborted');
        if (mutating) assert.match(error.message, /verify with capture before retrying/);
        return true;
      });
      assert.equal(fake.calls.length, 1);
      assert.deepEqual(fake.calls[0].writes, []);
      assert.equal(fake.calls[0].kills, 1);
    }
  }
});

test('synchronous stdin write abort never replays, even if the write then throws', async () => {
  for (const options of [{ alias: ALIAS }, { host: LOCAL_HOST }]) {
    for (const mutating of [false, true]) {
      for (const throwAfterAbort of [false, true]) {
        const controller = new AbortController();
        const { spawnImpl, calls } = fakeSpawn([{
          onWrite: () => {
            controller.abort();
            if (throwAfterAbort) {
              throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
            }
          },
          onKill: (child) => child.finish({ code: null, signal: 'SIGTERM' }),
        }]);
        const script = 'tmux send-keys -t %7 Enter\n';
        await expectCode(runRemote({
          cfg: CFG,
          ...options,
          script,
          nonce: NONCE,
          mutating,
          signal: controller.signal,
          spawnImpl,
        }), mutating ? CODES.OUTCOME_UNKNOWN : CODES.CANCELLED);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].writes, [script]);
        assert.ok(calls[0].kills >= 1);
      }
    }
  }
});

test('a stdin write failure is HOST_UNREACHABLE read-only, OUTCOME_UNKNOWN mutating', async () => {
  // EPIPE means the child exited before we could hand it the script. A
  // mutation is then classified as unknown (the script may or may not have
  // run); a read-only call is just unreachable.
  const readOnly = fakeSpawn([
    {
      writeThrows: true,
      onWrite: () => {},
      onKill: (child) => queueMicrotask(() => child.finish({ code: null, signal: 'SIGTERM' })),
    },
  ]);
  await expectCode(
    runRemote({
      cfg: CFG,
      alias: ALIAS,
      script: 'x',
      nonce: NONCE,
      timeoutMs: 500,
      spawnImpl: readOnly.spawnImpl,
    }),
    CODES.HOST_UNREACHABLE,
  );
  const mutating = fakeSpawn([
    {
      writeThrows: true,
      onWrite: () => {},
      onKill: (child) => queueMicrotask(() => child.finish({ code: null, signal: 'SIGTERM' })),
    },
  ]);
  await expectCode(
    runRemote({
      cfg: CFG,
      alias: ALIAS,
      script: 'x',
      nonce: NONCE,
      mutating: true,
      timeoutMs: 500,
      spawnImpl: mutating.spawnImpl,
    }),
    CODES.OUTCOME_UNKNOWN,
  );
  // The write failure points at a dead ssh, so the child must be terminated.
  assert.equal(readOnly.calls[0].kills, 1);
  assert.equal(mutating.calls[0].kills, 1);
});

test('runRemote rejects invalid arguments before spawning', async () => {
  const { spawnImpl, calls } = fakeSpawn([succeed(okOutput([]))]);
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: '', nonce: NONCE, spawnImpl }),
    CODES.INVALID_ARGUMENT,
  );
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: 'NOT-A-NONCE', spawnImpl }),
    CODES.INVALID_ARGUMENT,
  );
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, mutating: 'yes', spawnImpl }),
    CODES.INVALID_ARGUMENT,
  );
  assert.equal(calls.length, 0);
});

test('runRemote returns non-zero exit code with a complete protocol as REMOTE_ERROR', async () => {
  const { spawnImpl } = fakeSpawn([
    succeed(okOutput([]), { code: 3, stderr: 'tmux: boom\n' }),
  ]);
  await expectCode(
    runRemote({ cfg: CFG, alias: ALIAS, script: 'x', nonce: NONCE, spawnImpl }),
    CODES.REMOTE_ERROR,
  );
});

test('parseRecords requires a 12-hex nonce', () => {
  assert.throws(() => parseRecords('', 'xyz'), { code: CODES.INVALID_ARGUMENT });
  assert.throws(() => parseRecords('', 'A1B2C3D4E5F6'), { code: CODES.INVALID_ARGUMENT });
  assert.deepEqual(parseRecords('', NONCE), { records: [], sawBegin: false, sawEnd: false });
});

test('parseRecords ignores forged records that lack the nonce', () => {
  const forged =
    'XC1\x1fbegin\x1e\n' +
    'XC1deadbeefdead\x1fpane\x1f1-2\x1fs\x1f$9\x1e\n' +
    'XC1\x1fend\x1e\n';
  assert.deepEqual(parseRecords(forged, NONCE), { records: [], sawBegin: false, sawEnd: false });
});

test('parseRecords keeps field content containing lone separators and newlines', () => {
  const hostile = 'a\x1fb\x1ec\nd';
  const stdout = rec(['begin']) + rec(['pane', hostile]) + rec(['end']);
  const parsed = parseRecords(stdout, NONCE);
  assert.deepEqual(parsed.records, [['begin'], ['pane', hostile], ['end']]);
});

test('parseRecords accepts an empty field', () => {
  const stdout = rec(['begin']) + rec(['capture', '']) + rec(['end']);
  assert.deepEqual(parseRecords(stdout, NONCE).records[1], ['capture', '']);
});

test('parseRecords drops an incomplete trailing record', () => {
  const stdout = rec(['begin']) + start() + 'pane' + sep() + 'x';
  const parsed = parseRecords(stdout, NONCE);
  assert.deepEqual(parsed.records, [['begin']]);
  assert.equal(parsed.sawBegin, true);
  assert.equal(parsed.sawEnd, false);
});

test('parseRecords handles out-of-order and nested begin/end markers', () => {
  const stdout =
    rec(['end']) +
    'banner\n' +
    rec(['begin']) +
    start() + 'end' + stop() +
    rec(['end']);
  const parsed = parseRecords(stdout, NONCE);
  assert.equal(parsed.sawBegin, true);
  assert.equal(parsed.sawEnd, true);
  assert.deepEqual(parsed.records.map((r) => r[0]), ['end', 'begin', 'end', 'end']);
});
