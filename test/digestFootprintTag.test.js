import test from 'node:test';
import assert from 'node:assert/strict';
import {
  digestGateKey,
  isDigestFootprint,
  DIGEST_FOOTPRINT_TAG,
  materializePerProcessFootprint,
} from '../src/services/security/digestFootprintGate.js';

test('the gate key is scoped to the approver', () => {
  assert.equal(digestGateKey(42), 'digest:42');
});

test('isDigestFootprint identifies both gate and per-SO digest footprints', () => {
  assert.equal(isDigestFootprint('digest'), true); // per-SO audit copy
  assert.equal(isDigestFootprint('digest:42'), true); // gate row
  assert.equal(isDigestFootprint('8d3cd0ca-cd7f-4a15-abe3-9dd207025483'), false); // instant footprint (bare uuid)
  assert.equal(isDigestFootprint(''), false);
  assert.equal(isDigestFootprint(null), false);
});

test('the digest marker is short enough for the U_process_id column', () => {
  // A bare uuid is 36 chars and already fits; the tag must not be longer than that.
  assert.ok(DIGEST_FOOTPRINT_TAG.length <= 36);
});

test('materializePerProcessFootprint tags the audit copy as digest and copies the gate capture', async () => {
  const gateSession = {
    geo_method: 'granted',
    geo_lat: '19.07',
    geo_lon: '72.87',
    timezone: 'Asia/Kolkata',
    ip_address: '10.0.0.9',
    user_agent: 'UA',
    device_type: 'Desktop',
    operating_system: 'Windows 11',
    browser: 'Chrome 120',
    hostname: 'host.local',
  };

  let captured = null;
  const result = await materializePerProcessFootprint(
    { gateSession, draftEntry: 55 },
    {
      registerFootprintSession: async (arg) => {
        captured = arg;
        return { sessionId: 'fp-new', geoMethod: 'granted' };
      },
    }
  );

  // The audit copy is written with the short digest tag (fits the column).
  assert.equal(captured.processId, 'digest');
  // It copies the single capture's device/location and draft.
  assert.equal(captured.geoMethod, 'granted');
  assert.equal(captured.lat, '19.07');
  assert.equal(captured.lon, '72.87');
  assert.equal(captured.timezone, 'Asia/Kolkata');
  assert.equal(captured.draftEntry, 55);
  assert.equal(captured.serverFootprint.ipAddress, '10.0.0.9');
  assert.equal(captured.serverFootprint.browser, 'Chrome 120');
  // It returns the new row's id + timezone for the decision executor.
  assert.deepEqual(result, { session_id: 'fp-new', timezone: 'Asia/Kolkata', ip_address: '10.0.0.9' });
});
