import crypto from 'crypto';
import logger from '../../config/logger.js';
import { config } from '../../config/index.js';
import { GEO_METHOD, GATE_FAILURE } from './footprintConstants.js';
import { istIso } from '../audit/decisionLogShared.js';
import { query, execute, udt } from '../sap/hanaClient.js';

const T = () => udt('AP_FOOTPRINT');
const TTL_MS = 10 * 60 * 1000;

function normalizeGeoMethod(geoMethod, hasCoords) {
  if (geoMethod === GEO_METHOD.GRANTED && hasCoords) return GEO_METHOD.GRANTED;
  if (geoMethod === GEO_METHOD.DENIED || geoMethod === GEO_METHOD.TIMEOUT || geoMethod === GEO_METHOD.UNAVAILABLE) {
    return geoMethod;
  }
  return GEO_METHOD.UNAVAILABLE;
}

function toSession(r) {
  return {
    session_id: r.Code,
    process_id: r.U_process_id,
    draft_entry: r.U_DraftEntry ?? null,
    ip_address: r.U_ip_address ?? null,
    user_agent: r.U_user_agent ?? null,
    device_type: r.U_device_type ?? null,
    operating_system: r.U_os ?? null,
    browser: r.U_browser ?? null,
    country: null,
    city: null,
    hostname: r.U_hostname ?? null,
    timezone: r.U_timezone ?? null,
    geo_method: r.U_geo_method ?? null,
    geo_lat: r.U_geo_lat ?? null,
    geo_lon: r.U_geo_lon ?? null,
    geo_accuracy_m: null,
    captured_at: r.U_captured_at ?? null,
    expires_at: r.U_expires_at ?? null,
    consumed_at: r.U_consumed_at ?? null,
  };
}

export async function registerFootprintSession({ processId, geoMethod, lat, lon, accuracy, timezone, serverFootprint, draftEntry }) {
  const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
  const effectiveGeoMethod = normalizeGeoMethod(geoMethod, hasCoords);
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const draftEntryInt = Number.isFinite(Number(draftEntry)) ? Number(draftEntry) : null;

  await execute(
    `INSERT INTO ${T()} ("Code","Name","U_process_id","U_DraftEntry","U_ip_address","U_user_agent","U_device_type","U_os","U_browser","U_hostname","U_timezone","U_geo_method","U_geo_lat","U_geo_lon","U_captured_at","U_expires_at","U_consumed_at")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      sessionId,
      sessionId,
      processId,
      draftEntryInt,
      serverFootprint.ipAddress ?? null,
      serverFootprint.userAgent ?? null,
      serverFootprint.deviceType ?? null,
      serverFootprint.operatingSystem ?? null,
      serverFootprint.browser ?? null,
      serverFootprint.hostname ?? null,
      timezone || null,
      effectiveGeoMethod,
      hasCoords ? String(lat) : null,
      hasCoords ? String(lon) : null,
      istIso(now),
      istIso(new Date(now.getTime() + TTL_MS)),
      null,
    ]
  );

  const gateSatisfied = effectiveGeoMethod === GEO_METHOD.GRANTED || config.footprintGeoOptional;
  logger.info('hanaFootprintStore: registered footprint session', {
    processId,
    geoMethod: effectiveGeoMethod,
    geoOptional: config.footprintGeoOptional,
    sessionId: gateSatisfied ? sessionId : null,
  });
  return { sessionId: gateSatisfied ? sessionId : null, geoMethod: effectiveGeoMethod };
}

/** Fetch a footprint session by its id (Code), mapped to the app session shape. */
export async function getFootprintById(sessionId) {
  if (!sessionId) return null;
  const rows = await query(`SELECT * FROM ${T()} WHERE "Code" = ?`, [sessionId]);
  return rows.length ? toSession(rows[0]) : null;
}

export async function consumeFootprintSession({ sessionId, processId }) {
  if (!sessionId) return { ok: false, reason: GATE_FAILURE.NO_SESSION };

  const geoClause = config.footprintGeoOptional ? '' : `AND "U_geo_method" = 'granted'`;
  const nowIso = istIso();

  let affected;
  try {
    affected = await execute(
      `UPDATE ${T()} SET "U_consumed_at" = ?
        WHERE "Code" = ? AND "U_process_id" = ? ${geoClause}
          AND "U_consumed_at" IS NULL AND "U_expires_at" > ?`,
      [nowIso, sessionId, processId, nowIso]
    );
  } catch (error) {
    logger.warn('hanaFootprintStore: consume failed', { sessionId, processId, error: error?.message || String(error) });
    return { ok: false, reason: GATE_FAILURE.NO_SESSION };
  }

  if (affected === 1) {
    const rows = await query(`SELECT * FROM ${T()} WHERE "Code" = ?`, [sessionId]);
    return { ok: true, session: toSession(rows[0]) };
  }
  return { ok: false, reason: await determineReason(sessionId, processId) };
}

async function determineReason(sessionId, processId) {
  const rows = await query(
    `SELECT "U_geo_method","U_consumed_at","U_expires_at" FROM ${T()} WHERE "Code" = ? AND "U_process_id" = ?`,
    [sessionId, processId]
  );
  if (!rows.length) return GATE_FAILURE.NO_SESSION;
  const r = rows[0];
  if (!config.footprintGeoOptional && r.U_geo_method !== GEO_METHOD.GRANTED) return GATE_FAILURE.GEO_DENIED;
  if (r.U_consumed_at) return GATE_FAILURE.ALREADY_CONSUMED;
  return GATE_FAILURE.EXPIRED;
}
