export const DECISION_STATUS = Object.freeze({
  PENDING: 'Pending',
  SUCCESS: 'Success',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
});

/**
 * Format a UTC instant into the approver's local wall-clock string, e.g.
 * "2026-07-17 13:45 IST". Falls back to UTC when the timezone is missing/invalid.
 *
 * @param {Date} date
 * @param {string|null} timezone - IANA timezone from the client Intl API.
 * @returns {string}
 */
export function formatLocalTime(date, timezone) {
  const zone = timezone || 'UTC';
  try {
    return buildLocalTimeString(date, zone);
  } catch {
    return buildLocalTimeString(date, 'UTC');
  }
}

function buildLocalTimeString(date, zone) {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(date);

  const pick = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const zoneLabel = pick('timeZoneName');
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}${zoneLabel ? ` ${zoneLabel}` : ''}`;
}

export function toIntOrNull(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Current (or given) instant as an ISO-8601 string in IST (+05:30), e.g.
 * "2026-07-21T21:42:17.867+05:30". The wall-clock shown is IST, and because the
 * offset is constant these strings remain lexicographically (chronologically)
 * sortable for the range/expiry comparisons the stores do.
 */
export function istIso(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().replace('Z', '+05:30');
}
