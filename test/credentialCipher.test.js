import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from '../src/services/security/credentialCipher.js';

test('encrypt then decrypt returns the original secret', () => {
  for (const secret of ['4213', 'Sap@123mi', 'contains:colons:and spaces', '']) {
    assert.equal(decryptSecret(encryptSecret(secret)), secret);
  }
});

test('ciphertext is not the plaintext and varies per call (random IV)', () => {
  const a = encryptSecret('Sap@123mi');
  const b = encryptSecret('Sap@123mi');
  assert.notEqual(a, 'Sap@123mi');
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), decryptSecret(b));
});

test('tampered ciphertext fails the GCM auth check', () => {
  const enc = encryptSecret('Sap@123mi');
  const [iv, tag, data] = enc.split(':');
  const flipped = data[0] === 'A' ? 'B' : 'A';
  const tampered = [iv, tag, flipped + data.slice(1)].join(':');
  assert.throws(() => decryptSecret(tampered));
});

test('malformed payload throws', () => {
  assert.throws(() => decryptSecret('not-valid'));
});
