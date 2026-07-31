export const GEO_METHOD = Object.freeze({
  GRANTED: 'granted',
  DENIED: 'denied',
  UNAVAILABLE: 'unavailable',
  TIMEOUT: 'timeout',
});

export const DEVICE_TYPE = Object.freeze({
  DESKTOP: 'Desktop',
  MOBILE: 'Mobile',
  TABLET: 'Tablet',
  UNKNOWN: 'Unknown',
});

/**
 * Reasons a footprint gate check can fail. Mirrors the failure_reason strings
 * persisted to the audit record so audits read consistently.
 */
export const GATE_FAILURE = Object.freeze({
  NO_SESSION: 'no footprint session',
  GEO_DENIED: 'geolocation denied',
  ALREADY_CONSUMED: 'footprint session already used',
  EXPIRED: 'footprint expired',
});
