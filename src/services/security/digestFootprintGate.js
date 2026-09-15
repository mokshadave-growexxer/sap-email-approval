import { registerFootprintSession as defaultRegisterFootprintSession, consumeFootprintSession } from './hanaFootprintStore.js';

// The bulk digest page captures device/location ONCE. That single capture is a
// gate row (keyed to the approver, not a single SO) which is consumed once at
// submit — the security boundary for the whole batch. At submit, one audit
// footprint row is then materialized PER decided SO (a copy of the gate capture),
// so the existing per-document footprint linkage keeps working unchanged: each
// decided process references its own footprint row.
//
// Footprints written by the digest channel are marked in U_process_id so a
// bulk-approved decision is identifiable in the audit:
//   - gate row       -> "digest:<sapUserId>"   (consumed once per submit)
//   - per-SO copy    -> "digest"               (linked from the @AP_APPROVAL row)
// Instant single-click footprints keep the bare process id, so an approved
// @AP_APPROVAL row whose linked footprint's U_process_id starts with "digest"
// was bulk-approved. The marker is kept short on purpose: the U_process_id column
// is sized for a bare id, so "digest:<processId>" would overflow it — the SO's
// process id stays recoverable from the @AP_APPROVAL row that links the footprint.
export const DIGEST_PROCESS_PREFIX = 'digest:';
export const DIGEST_FOOTPRINT_TAG = 'digest';

/** The gate row's key for one approver (the single capture consumed per submit). */
export function digestGateKey(sapUserId) {
  return `${DIGEST_PROCESS_PREFIX}${sapUserId}`;
}

/** Whether an @AP_FOOTPRINT.U_process_id was written by the digest channel. */
export function isDigestFootprint(uProcessId) {
  return String(uProcessId ?? '').startsWith(DIGEST_FOOTPRINT_TAG);
}

export async function registerDigestGate({ sapUserId, geoMethod, lat, lon, accuracy, timezone, serverFootprint }) {
  return defaultRegisterFootprintSession({
    processId: digestGateKey(sapUserId),
    geoMethod,
    lat,
    lon,
    accuracy,
    timezone,
    serverFootprint,
    draftEntry: null,
  });
}

export async function consumeDigestGate({ sessionId, sapUserId }) {
  return consumeFootprintSession({ sessionId, processId: digestGateKey(sapUserId) });
}

/**
 * Record an audit footprint for one decided SO, copying the gate capture's
 * device/location and tagging it as a digest (bulk) decision. Returns the minimal
 * session shape the decision executor needs (its id becomes the process's
 * footprint id; its timezone stamps the audit). The SO it belongs to is the
 * @AP_APPROVAL row whose U_footprint_id is the returned session_id.
 *
 * @param {{ gateSession: object, draftEntry: (number|string|null) }} params
 * @param {{ registerFootprintSession?: Function }} [deps] - Injection seam for tests.
 * @returns {Promise<{ session_id: string|null, timezone: string|null, ip_address: string|null }>}
 */
export async function materializePerProcessFootprint(
  { gateSession, draftEntry },
  { registerFootprintSession = defaultRegisterFootprintSession } = {}
) {
  const result = await registerFootprintSession({
    processId: DIGEST_FOOTPRINT_TAG,
    geoMethod: gateSession.geo_method,
    lat: gateSession.geo_lat,
    lon: gateSession.geo_lon,
    timezone: gateSession.timezone,
    serverFootprint: {
      ipAddress: gateSession.ip_address,
      userAgent: gateSession.user_agent,
      deviceType: gateSession.device_type,
      operatingSystem: gateSession.operating_system,
      browser: gateSession.browser,
      hostname: gateSession.hostname,
    },
    draftEntry,
  });
  return { session_id: result.sessionId, timezone: gateSession.timezone, ip_address: gateSession.ip_address };
}
