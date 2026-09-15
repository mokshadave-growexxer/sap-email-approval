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

/** The monitoring BCC address for a send, or undefined when unset or equal to the recipient. */
export function resolveBccRecipient(recipientEmail, bcc = config.emailBcc) {
  if (!bcc) {
    return undefined;
  }
  if (String(recipientEmail || '').trim().toLowerCase() === String(bcc).trim().toLowerCase()) {
    return undefined;
  }
  return bcc;
}
