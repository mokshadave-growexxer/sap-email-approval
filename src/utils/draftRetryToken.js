import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

// A parked draft is never re-posted by the app on its own, so the alert email
// carries the only way back in: a signed link that clears the park for exactly
// one draft. Stateless and unforgeable without the app secret, mirroring the
// digest link. The company is carried by the URL's company hash, so no schema
// or company name appears in the token. The audience pins it to this one
// purpose, so a digest or app token can never be replayed as a retry link.
const DRAFT_RETRY_TOKEN_AUDIENCE = 'sap-approval-draft-retry';

// A parked draft usually waits on a human fixing master data or stock, which
// can take days. The link outlives that without being effectively permanent.
const DEFAULT_TTL = '30d';

/**
 * Sign a retry link token for one parked draft.
 *
 * @param {{ approvalRequestId: string|number, draftEntry: string|number }} claims
 * @returns {string} Signed HS512 JWT.
 */
export function signDraftRetryToken(
  { approvalRequestId, draftEntry },
  { secret = config.jwtSecret, expiresIn = DEFAULT_TTL, audience = DRAFT_RETRY_TOKEN_AUDIENCE } = {}
) {
  return jwt.sign({ ar: String(approvalRequestId), de: String(draftEntry) }, secret, {
    algorithm: 'HS512',
    audience,
    expiresIn,
  });
}

/**
 * Verify a retry link token. Never throws — an invalid, expired or forged token
 * returns `{ valid: false }` so the route can render a friendly page.
 *
 * @param {string} token
 * @returns {Readonly<{valid: boolean, approvalRequestId: string|null, draftEntry: string|null, expired: boolean}>}
 */
export function verifyDraftRetryToken(token, { secret = config.jwtSecret } = {}) {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS512'],
      audience: DRAFT_RETRY_TOKEN_AUDIENCE,
    });
    return Object.freeze({
      valid: true,
      approvalRequestId: String(payload.ar),
      draftEntry: String(payload.de),
      expired: false,
    });
  } catch (error) {
    return Object.freeze({
      valid: false,
      approvalRequestId: null,
      draftEntry: null,
      expired: error?.name === 'TokenExpiredError',
    });
  }
}
