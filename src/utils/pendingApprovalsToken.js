import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

// A "Pending approvals" link (approval email / decision page) identifies one
// approval process and nothing more; the route resolves that process's approver
// and hands off to the bulk page. It is a signed, expiring token so an old email
// stops opening the approver's live queue after PENDING_APPROVALS_LINK_TTL. The
// audience pins it to this one purpose, so a digest or other app token can never
// be replayed here (and vice versa).
const PENDING_APPROVALS_TOKEN_AUDIENCE = 'sap-approval-pending';
export const PENDING_APPROVALS_LINK_TTL = '10d';

/**
 * Sign a "Pending approvals" link token for an approval process.
 *
 * @param {{ processId: string }} claims
 * @param {{ secret?: string, expiresIn?: string|number }} [options]
 * @returns {string} Signed HS512 JWT.
 */
export function signPendingApprovalsToken(
  { processId },
  { secret = config.jwtSecret, expiresIn = PENDING_APPROVALS_LINK_TTL } = {}
) {
  return jwt.sign({ pid: String(processId) }, secret, {
    algorithm: 'HS512',
    audience: PENDING_APPROVALS_TOKEN_AUDIENCE,
    expiresIn,
  });
}

/**
 * Verify a "Pending approvals" link token. Never throws — an invalid/expired/
 * forged token returns `{ valid: false }` so the route can render a friendly page.
 *
 * @param {string} token
 * @param {{ secret?: string }} [options]
 * @returns {Readonly<{ valid: boolean, processId: string|null, expired: boolean }>}
 */
export function verifyPendingApprovalsToken(token, { secret = config.jwtSecret } = {}) {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS512'],
      audience: PENDING_APPROVALS_TOKEN_AUDIENCE,
    });
    if (!payload?.pid) {
      return Object.freeze({ valid: false, processId: null, expired: false });
    }
    return Object.freeze({ valid: true, processId: String(payload.pid), expired: false });
  } catch (error) {
    return Object.freeze({ valid: false, processId: null, expired: error?.name === 'TokenExpiredError' });
  }
}
