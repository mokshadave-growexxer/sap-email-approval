import nodemailer from 'nodemailer';
import { config } from '../../config/index.js';

// One SMTP transport per company sender, built lazily and cached by company key.
// Each company mails from its own configured identity (e.g. MILLP from
// approval@matangiindustries.com, MSPL from approval@minalspecialities.com).
// Shared by the instant approval email and the daily digest so both send with
// the same, correctly-scoped credentials.
const transportersByCompany = new Map();

export function getCompanyTransporter(companyKey, smtp) {
  let transporter = transportersByCompany.get(companyKey);
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
    });
    transportersByCompany.set(companyKey, transporter);
  }
  return transporter;
}

/**
 * The monitoring BCC for a send: EMAIL_BCC may list several addresses separated
 * by commas or semicolons. Blanks and duplicates are dropped, and the
 * recipient's own address is removed so nobody is both To and BCC on the same
 * mail. Returns a comma-separated string for nodemailer, or undefined when
 * nothing is left to BCC.
 */
export function resolveBccRecipient(recipientEmail, bcc = config.emailBcc) {
  if (!bcc) {
    return undefined;
  }

  const recipient = String(recipientEmail || '').trim().toLowerCase();
  const seen = new Set();
  const addresses = [];

  for (const raw of String(bcc).split(/[,;]/)) {
    const address = raw.trim();
    if (!address) continue;
    const key = address.toLowerCase();
    if (key === recipient || seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
  }

  return addresses.length ? addresses.join(',') : undefined;
}
