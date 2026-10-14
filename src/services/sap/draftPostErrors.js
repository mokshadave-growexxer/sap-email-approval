// Classifies a SaveDraftToDocument failure so the poster knows whether trying
// again could ever help.
//
// WHY THIS EXISTS: SAP allocates ORDR.DocEntry when the add transaction starts
// and does NOT return it on rollback. So every failed post burns a DocEntry
// permanently. Retrying an error that can never succeed burns one number per
// attempt, forever — which is exactly how the 30s queue poll consumed ~4,450
// DocEntry/day. Classifying the error is what bounds the burn to one number per
// genuinely broken draft.
//
// The default is deliberately PERMANENT: anything we do not positively
// recognise as transient is parked after a single attempt and reported to a
// human. Mis-parking a recoverable draft costs one email; mis-retrying an
// unrecoverable one costs 2,880 burned DocEntry per day. The asymmetry decides
// the default.

export const DRAFT_POST_FAILURE = Object.freeze({
  /** Infrastructure/contention. Retrying can plausibly succeed. */
  TRANSIENT: 'transient',
  /** The request was sent but the outcome is unknown (timeout / socket drop).
   *  SAP may have committed. Never re-POST without verifying first. */
  AMBIGUOUS: 'ambiguous',
  /** A business rule said no. Retrying burns a DocEntry and changes nothing. */
  PERMANENT: 'permanent',
});

// SAP B1 signals a record held open by another user with these codes. Same set
// the decision path already recognises (approvalService.isSapLockError).
const LOCK_ERROR_CODES = new Set(['-1029', '-2028']);
// Deliberately narrow: it must read like "someone else has this open", not just
// contain the word "lock". A closed posting period ("period is locked") is a
// PERMANENT business failure — matching it here would put it on the retry path
// and burn a DocEntry on every attempt, which is the bug this module exists to
// prevent. So require a user/record subject, not the word alone.
const LOCK_MESSAGE = /another user|other user|record is locked|being modified|being used|currently in use/;

// Service Layer session died (cookie expired, SL recycled). Re-login and retry.
const SESSION_MESSAGE = /invalid session|session.{0,12}expired|not logged in|login again/;

// Node/undici network failures: the socket never produced an HTTP response.
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function sapErrorCode(error) {
  const data = error?.response?.data;
  return String(data?.error?.code ?? data?.code ?? '').trim();
}

function sapErrorMessage(error) {
  const data = error?.response?.data;
  const value = data?.error?.message?.value ?? data?.message?.value ?? data?.error?.message ?? error?.message;
  return String(value ?? '').toLowerCase();
}

/**
 * Decide whether a failed SaveDraftToDocument may be retried.
 *
 * @param {unknown} error - The error thrown by the Service Layer POST.
 * @returns {Readonly<{classification: string, retryable: boolean, mustVerify: boolean, code: string, message: string, status: (number|null)}>}
 */
export function classifyDraftPostFailure(error) {
  const status = error?.response?.status ?? null;
  const code = sapErrorCode(error);
  const message = sapErrorMessage(error);
  const transportCode = String(error?.code ?? '');

  const decide = (classification) =>
    Object.freeze({
      classification,
      retryable: classification !== DRAFT_POST_FAILURE.PERMANENT,
      // An ambiguous outcome must be checked against SAP before any re-POST,
      // or we risk creating a duplicate Sales Order.
      mustVerify: classification === DRAFT_POST_FAILURE.AMBIGUOUS,
      code,
      message,
      status,
    });

  // No HTTP response came back. The POST may or may not have committed in SAP.
  if (!error?.response) {
    if (NETWORK_CODES.has(transportCode) || /timeout|socket hang up|network/.test(message)) {
      return decide(DRAFT_POST_FAILURE.AMBIGUOUS);
    }
    // A local programming error (bad argument, undefined client) — not SAP's
    // fault and not fixed by waiting.
    return decide(DRAFT_POST_FAILURE.PERMANENT);
  }

  // Session expired: re-login and try again. Nothing was committed.
  if (status === 401 || SESSION_MESSAGE.test(message)) {
    return decide(DRAFT_POST_FAILURE.TRANSIENT);
  }

  // Service Layer / HANA unavailable or overloaded.
  if (status === 408 || status === 429 || (typeof status === 'number' && status >= 500)) {
    return decide(DRAFT_POST_FAILURE.TRANSIENT);
  }

  // The draft (or a master-data record it touches) is open in someone's client.
  if (LOCK_ERROR_CODES.has(code) && LOCK_MESSAGE.test(message)) {
    return decide(DRAFT_POST_FAILURE.TRANSIENT);
  }
  if (/locked by another user|being used by another user|record is locked/.test(message)) {
    return decide(DRAFT_POST_FAILURE.TRANSIENT);
  }

  // Everything else — business validation, stock, credit limit, closed period,
  // missing series, a blocked item — is permanent until a human intervenes.
  return decide(DRAFT_POST_FAILURE.PERMANENT);
}

export default classifyDraftPostFailure;
