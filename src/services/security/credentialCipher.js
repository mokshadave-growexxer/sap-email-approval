import crypto from 'crypto';
import { config } from '../../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

function getKey() {
  const hex = config.credentialsEncKey;
  if (!hex) {
    throw new Error('CREDENTIALS_ENC_KEY is not set — cannot encrypt/decrypt SAP credentials.');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(`CREDENTIALS_ENC_KEY must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars).`);
  }
  return key;
}

/**
 * Encrypt a plaintext secret. Output is a self-describing string
 * "iv:authTag:ciphertext", each part base64. Safe to store as text.
 *
 * @param {string} plaintext
 * @returns {string}
 */
export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypt a string produced by encryptSecret. Throws if the key is wrong or the
 * ciphertext was tampered with (GCM auth tag mismatch).
 *
 * @param {string} payload
 * @returns {string}
 */
export function decryptSecret(payload) {
  const parts = String(payload).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret.');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}
