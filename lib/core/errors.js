/**
 * Error taxonomy shared by every dsh-tmux-xc module.
 *
 * Codes are stable strings: they cross the tool boundary and are rendered in
 * the UI, so never rename an existing value.
 */

export const CODES = Object.freeze({
  HOST_NOT_ALLOWED: 'HOST_NOT_ALLOWED',
  SOCKET_NOT_ALLOWED: 'SOCKET_NOT_ALLOWED',
  HOST_UNREACHABLE: 'HOST_UNREACHABLE',
  SSH_AUTH: 'SSH_AUTH',
  SSH_HOSTKEY: 'SSH_HOSTKEY',
  REMOTE_TOOL_MISSING: 'REMOTE_TOOL_MISSING',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  PROTOCOL: 'PROTOCOL',
  OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
  SERVER_GONE: 'SERVER_GONE',
  SERVER_RESTARTED: 'SERVER_RESTARTED',
  HOST_IDENTITY_CHANGED: 'HOST_IDENTITY_CHANGED',
  TARGET_GONE: 'TARGET_GONE',
  TARGET_CHANGED: 'TARGET_CHANGED',
  REGISTRY_UNAVAILABLE: 'REGISTRY_UNAVAILABLE',
  SYNCHRONIZED_PANES: 'SYNCHRONIZED_PANES',
  PANE_IN_MODE: 'PANE_IN_MODE',
  PANE_DEAD: 'PANE_DEAD',
  PANE_INPUT_DISABLED: 'PANE_INPUT_DISABLED',
  AMBIGUOUS: 'AMBIGUOUS',
  APPROVAL_CANCELLED: 'APPROVAL_CANCELLED',
  APPROVAL_MISSING: 'APPROVAL_MISSING',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  REMOTE_ERROR: 'REMOTE_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFIRM_MISMATCH: 'CONFIRM_MISMATCH',
  SSH_MISSING: 'SSH_MISSING',
});

const CODE_VALUES = new Set(Object.values(CODES));

export class XcError extends Error {
  /**
   * @param {string} code one of {@link CODES}
   * @param {string} message human-readable message
   * @param {Record<string, unknown>} [details] structured, non-secret context
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'XcError';
    this.code = code;
    this.details = details;
  }
}

/**
 * True when `value` is one of the declared CODES values.
 * @param {unknown} value
 */
export function isXcCode(value) {
  return typeof value === 'string' && CODE_VALUES.has(value);
}
