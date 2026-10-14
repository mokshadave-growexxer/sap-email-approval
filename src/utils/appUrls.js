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

// Link tokens ride in the query string (?t=<token>), not a path segment: IIS's
// HTTP.sys rejects any single path segment over 260 characters (UrlSegmentMaxLength)
// with "400 Bad Request - Invalid URL" before the request ever reaches Node, and
// a signed HS512 JWT easily exceeds that. The query string has no such limit.
export const LINK_TOKEN_QUERY_PARAM = 't';

function withLinkToken(path, token) {
  return `${path}?${LINK_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * The link token of a request: `?t=<token>`, or the legacy `/<route>/<token>`
 * path form so links already sent in emails keep working. A repeated or empty
 * `t` yields '' (an invalid token), never an array.
 */
export function linkTokenFromRequest(req) {
  const fromQuery = req.query?.[LINK_TOKEN_QUERY_PARAM];
  if (fromQuery !== undefined) {
    return typeof fromQuery === 'string' ? fromQuery : '';
  }
  return typeof req.params?.token === 'string' ? req.params.token : '';
}

/**
 * "Pending approvals" entry point carried by an instant approval email and the
 * decision page, e.g. '/salesorder/api/v1/c/<hash>/pending?t=<token>'. The token
 * (see pendingApprovalsToken.js) names one process and expires after 10 days;
 * the route resolves that process's approver and redirects to a freshly signed
 * bulk page link.
 */
export function companyPendingApprovalsPath(companyHash, pendingToken) {
  return withLinkToken(`${companyPath(companyHash)}/pending`, pendingToken);
}

/** Retry link for one parked draft, e.g. '/salesorder/api/v1/c/<hash>/draft-retry?t=<token>'. */
export function companyDraftRetryPath(companyHash, retryToken) {
  return withLinkToken(`${companyPath(companyHash)}/draft-retry`, retryToken);
}

/** Absolute retry URL for the parked-draft alert email's button. */
export function absoluteDraftRetryUrl(companyHash, retryToken) {
  return `${absoluteOrigin()}${companyDraftRetryPath(companyHash, retryToken)}`;
}

/** Absolute action URL for the email button: origin + base path + action route. */
export function absoluteActionUrl(companyHash, processId) {
  return `${absoluteOrigin()}${companyActionPath(companyHash, processId)}`;
}

/** Absolute bulk digest URL for the digest email's "Take Action" button. */
export function absoluteQueueUrl(companyHash, digestToken) {
  return `${absoluteOrigin()}${companyQueuePath(companyHash, digestToken)}`;
}

/** Absolute URL for the approval email's "Pending approvals" button. */
export function absolutePendingApprovalsUrl(companyHash, pendingToken) {
  return `${absoluteOrigin()}${companyPendingApprovalsPath(companyHash, pendingToken)}`;
}

function absoluteOrigin() {
  return String(config.appBaseUrl ?? '').replace(/\/+$/, '');
}
