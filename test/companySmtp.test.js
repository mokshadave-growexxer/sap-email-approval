import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCompanySmtp } from '../src/config/index.js';

const globalSmtp = {
  host: 'smtp.gmail.com',
  port: 587,
  user: 'approval@matangiindustries.com',
  pass: 'millp-pass',
  from: 'approval@matangiindustries.com',
};

test('company with no override uses the global sender entirely', () => {
  assert.deepEqual(resolveCompanySmtp('millp', globalSmtp, {}), {
    host: 'smtp.gmail.com',
    port: 587,
    user: 'approval@matangiindustries.com',
    pass: 'millp-pass',
    from: 'approval@matangiindustries.com',
  });
});

test('company with its own mailbox sends from its own identity', () => {
  const env = {
    SMTP_MSPL_USER: 'approval@minalspecialities.com',
    SMTP_MSPL_PASS: 'mspl-pass',
    SMTP_MSPL_FROM: 'approval@minalspecialities.com',
  };
  assert.deepEqual(resolveCompanySmtp('mspl', globalSmtp, env), {
    host: 'smtp.gmail.com', // falls back to global
    port: 587, // falls back to global
    user: 'approval@minalspecialities.com',
    pass: 'mspl-pass',
    from: 'approval@minalspecialities.com',
  });
});

test('own mailbox NEVER inherits the global password (no cross-account bleed)', () => {
  // MSPL declares its own USER but its PASS is not yet filled in.
  const env = { SMTP_MSPL_USER: 'approval@minalspecialities.com' };
  const smtp = resolveCompanySmtp('mspl', globalSmtp, env);
  assert.equal(smtp.user, 'approval@minalspecialities.com');
  assert.equal(smtp.pass, ''); // NOT globalSmtp.pass — refuses to send MSPL with MILLP's password
  assert.equal(smtp.from, 'approval@minalspecialities.com'); // defaults to own user
});

test('per-company HOST/PORT override the global relay when set', () => {
  const env = {
    SMTP_MSPL_USER: 'approval@minalspecialities.com',
    SMTP_MSPL_PASS: 'p',
    SMTP_MSPL_HOST: 'smtp.office365.com',
    SMTP_MSPL_PORT: '465',
  };
  const smtp = resolveCompanySmtp('mspl', globalSmtp, env);
  assert.equal(smtp.host, 'smtp.office365.com');
  assert.equal(smtp.port, 465);
});
