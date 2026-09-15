import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

// A digest link identifies exactly one approver (their SAP UserID) and nothing
// more. It is a signed, expiring token rather than a stored row: stateless, so
// no new HANA UDT is needed, and unforgeable without the app secret. The company
// is carried separately by the URL's company hash, so the schema/company name
// never appears here. The audience pins the token to this one purpose, so an
// unrelated app token can never be replayed as a digest link.
const DIGEST_TOKEN_AUDIENCE = 'sap-approval-digest';

/**
 * Sign a digest link token for an approver.
 *
 * @param {{ sapUserId: string|number }} claims
 * @param {{ secret?: string, expiresIn?: string|number, audience?: string }} [options]
 * @returns {string} Signed HS512 JWT.
 */
export function signDigestToken(
  { sapUserId },
  { secret = config.jwtSecret, expiresIn = `${config.digest.tokenTtlHours}h`, audience = DIGEST_TOKEN_AUDIENCE } = {}
) {
  return jwt.sign({ uid: String(sapUserId) }, secret, {
    algorithm: 'HS512',
    audience,
    expiresIn,
  });
}

/**
 * Verify a digest link token. Never throws — an invalid/expired/forged token
 * returns `{ valid: false }` so route code can render a friendly page.
 *
 * @param {string} token
 * @param {{ secret?: string }} [options]
 * @returns {Readonly<{ valid: boolean, sapUserId: string|null, expired: boolean }>}
 */
export function verifyDigestToken(token, { secret = config.jwtSecret } = {}) {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS512'], audience: DIGEST_TOKEN_AUDIENCE });
    return Object.freeze({ valid: true, sapUserId: String(payload.uid), expired: false });
  } catch (error) {
    return Object.freeze({ valid: false, sapUserId: null, expired: error?.name === 'TokenExpiredError' });
  }
}
