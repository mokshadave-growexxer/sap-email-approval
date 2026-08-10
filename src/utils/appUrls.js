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

/** Absolute action URL for the email button: origin + base path + action route. */
export function absoluteActionUrl(companyHash, processId) {
  const origin = String(config.appBaseUrl ?? '').replace(/\/+$/, '');
  return `${origin}${companyActionPath(companyHash, processId)}`;
}
