import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../../db.js';
import logger from '../../config/logger.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set — refusing to start with no signing secret.');
}

const TOKEN_TTL = process.env.APPROVAL_TOKEN_TTL || '72h';
const ISSUER = 'sap-b1-approval-system';
const ACTIONS = Object.freeze({ APPROVE: 'approve', REJECT: 'reject' });

export const tokenStore = {
  async isUsed(jti) {
    const res = await query('SELECT 1 FROM used_action_tokens WHERE jti = $1', [jti]);
    return res.rowCount > 0;
  },
  async markUsed(jti) {
    try {
      await query('INSERT INTO used_action_tokens (jti) VALUES ($1)', [jti]);
    } catch (err) {
      if (err.code === '23505') {
        return;
      }
      throw err;
    }
  },
};

class TokenError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
  }
}

export class TokenExpiredError extends TokenError {
  constructor() {
    super('Token has expired.', 'TOKEN_EXPIRED');
    this.name = 'TokenExpiredError';
  }
}

export class TokenInvalidError extends TokenError {
  constructor(detail) {
    super(`Token is invalid: ${detail}`, 'TOKEN_INVALID');
    this.name = 'TokenInvalidError';
  }
}

export class TokenAlreadyUsedError extends TokenError {
  constructor() {
    super('Token has already been used.', 'TOKEN_ALREADY_USED');
    this.name = 'TokenAlreadyUsedError';
  }
}

function generateActionToken({ approvalRequestId, approverUserId, stageId, action }) {
  if (action !== ACTIONS.APPROVE && action !== ACTIONS.REJECT) {
    throw new TokenInvalidError(`unknown action '${action}'`);
  }

  const jti = crypto.randomUUID();

  const token = jwt.sign(
    { approvalRequestId, approverUserId, stageId, action },
    JWT_SECRET,
    { jwtid: jti, issuer: ISSUER, expiresIn: TOKEN_TTL }
  );

  logger.info('tokenService: issued token', { jti, approvalRequestId, approverUserId, action });
  return token;
}

export function generateActionTokenPair({ approvalRequestId, approverUserId, stageId }) {
  return {
    approveToken: generateActionToken({ approvalRequestId, approverUserId, stageId, action: ACTIONS.APPROVE }),
    rejectToken: generateActionToken({ approvalRequestId, approverUserId, stageId, action: ACTIONS.REJECT }),
  };
}

export async function validateToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET, { issuer: ISSUER });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new TokenExpiredError();
    throw new TokenInvalidError(err.message);
  }

  const jti = decoded.jti;
  if (!jti) throw new TokenInvalidError('missing jti');

  const used = await tokenStore.isUsed(jti);
  if (used) throw new TokenAlreadyUsedError();

  return decoded;
}

export async function consumeToken(jti) {
  await tokenStore.markUsed(jti);
  logger.info('tokenService: consumed token', { jti });
}

export { ACTIONS };
