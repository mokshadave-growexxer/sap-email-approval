import express from 'express';
import logger from '../config/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  GEO_METHOD,
  captureServerSideFootprint,
  registerFootprintSession,
  refineOperatingSystem,
} from '../services/security/footprintService.js';
import { getProcess } from '../services/approval/processStore.js';
import { FOOTPRINT_CLIENT_JS } from './footprintClientScript.js';

const router = express.Router();

const VALID_GEO_METHODS = new Set(Object.values(GEO_METHOD));

// Served from the app origin so it satisfies CSP script-src 'self'.
router.get('/footprint/client.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(FOOTPRINT_CLIENT_JS);
});

/**
 * Records a footprint session on page load. Only the geolocation coords and the
 * client timezone are trusted from the body; IP/UA/device/geoip/hostname are
 * re-derived server-side. A row is written for every attempt — granted or not —
 * so denied/timeout attempts remain auditable.
 */
router.post(
  '/footprint/register',
  asyncHandler(async (req, res) => {
    const { lat, lon, accuracy, timezone } = req.body || {};
    const processId = req.body?.process_id;
    const geoMethod = VALID_GEO_METHODS.has(req.body?.geo_method) ? req.body.geo_method : GEO_METHOD.UNAVAILABLE;

    if (!processId || typeof processId !== 'string') {
      return res.status(400).json({ error: 'process_id is required' });
    }

    const serverFootprint = await captureServerSideFootprint(req);
    const operatingSystem = refineOperatingSystem(serverFootprint.operatingSystem, req.body?.ua_platform_version);
    const draftEntry = (await getProcess(processId))?.draft_entry ?? null;

    let result;
    try {
      result = await registerFootprintSession({
        processId,
        geoMethod: lat != null && lon != null ? GEO_METHOD.GRANTED : geoMethod,
        lat,
        lon,
        accuracy,
        timezone,
        serverFootprint: { ...serverFootprint, operatingSystem },
        draftEntry,
      });
    } catch (error) {
      // Unknown/malformed process_id (FK/UUID) — do not leak details.
      logger.warn('footprint/register: could not register session', {
        processId,
        error: error?.message || String(error),
      });
      return res.status(400).json({ session_id: null, reason: 'invalid process' });
    }

    if (result.sessionId) {
      return res.status(201).json({ session_id: result.sessionId });
    }

    logger.info('footprint/register: session not granted', { processId, geoMethod: result.geoMethod });
    return res.status(201).json({ session_id: null, reason: result.geoMethod });
  })
);

export default router;
