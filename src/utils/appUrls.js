import { config } from '../config/index.js';

// Single source of truth for every public URL the app emits. All links — email
// buttons, decision-page form action, footprint endpoints — are built here so
// the configured base path (config.basePath, e.g. '/salesorder') is applied
// consistently and can never drift between the mount point and the links.

/** The mounted API root, e.g. '/salesorder/api/v1' (or '/api/v1' with no base path). */
export function apiBasePath() {
  return `${config.basePath}/api/v1`;
}

/** Company-scoped path root, e.g. '/salesorder/api/v1/c/<hash>'. */
export function companyPath(companyHash) {
  return `${apiBasePath()}/c/${companyHash}`;
}

export function companyActionPath(companyHash, processId) {
  return `${companyPath(companyHash)}/action/${processId}`;
}

export function companyFootprintRegisterPath(companyHash) {
  return `${companyPath(companyHash)}/footprint/register`;
}

export function companyFootprintClientPath(companyHash) {
  return `${companyPath(companyHash)}/footprint/client.js`;
}

/** Bulk digest page for one approver, e.g. '/salesorder/api/v1/c/<hash>/queue/<token>'. */
export function companyQueuePath(companyHash, digestToken) {
  return `${companyPath(companyHash)}/queue/${digestToken}`;
}

/** Footprint register endpoint for the bulk digest page (token-scoped). */
export function companyQueueFootprintRegisterPath(companyHash, digestToken) {
  return `${companyQueuePath(companyHash, digestToken)}/footprint/register`;
}

/** The bulk digest page's browser client script (company-scoped, static). */
export function companyQueueClientPath(companyHash) {
  return `${companyPath(companyHash)}/queue/client.js`;
}

/** Absolute action URL for the email button: origin + base path + action route. */
export function absoluteActionUrl(companyHash, processId) {
  return `${absoluteOrigin()}${companyActionPath(companyHash, processId)}`;
}

/** Absolute bulk digest URL for the digest email's "Take Action" button. */
export function absoluteQueueUrl(companyHash, digestToken) {
  return `${absoluteOrigin()}${companyQueuePath(companyHash, digestToken)}`;
}

function absoluteOrigin() {
  return String(config.appBaseUrl ?? '').replace(/\/+$/, '');
}
