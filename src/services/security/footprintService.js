import dns from 'dns';
import { UAParser } from 'ua-parser-js';
import geoip from 'geoip-lite';
import logger from '../../config/logger.js';
import { GEO_METHOD, DEVICE_TYPE, GATE_FAILURE } from './footprintConstants.js';

export { GEO_METHOD, DEVICE_TYPE, GATE_FAILURE };

// Session persistence lives in the SAP HANA UDT @AP_FOOTPRINT.
export { registerFootprintSession, consumeFootprintSession, getFootprintById } from './hanaFootprintStore.js';

const REVERSE_DNS_TIMEOUT_MS = 500;

function normalizeIp(rawIp) {
  if (!rawIp) return null;
  const ip = String(rawIp).trim();
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

export function getClientIp(req) {
  // app.js sets `trust proxy`, so req.ip already honours X-Forwarded-For.
  return normalizeIp(req?.ip);
}

function mapDeviceType(uaDeviceType) {
  switch (uaDeviceType) {
    case 'mobile':
      return DEVICE_TYPE.MOBILE;
    case 'tablet':
      return DEVICE_TYPE.TABLET;
    case undefined:
    case null:
    case '':
      return DEVICE_TYPE.DESKTOP;
    default:
      return DEVICE_TYPE.UNKNOWN;
  }
}

/**
 * Chrome reports "Windows NT 10.0" in its User-Agent for BOTH Windows 10 and
 * Windows 11, so the UA string alone cannot tell them apart. UA Client Hints'
 * platformVersion disambiguates: a major version >= 13 means Windows 11.
 *
 * @param {string|null} operatingSystem - OS label parsed from the UA header.
 * @param {string|null} platformVersion - navigator.userAgentData platformVersion.
 * @returns {string|null}
 */
export function refineOperatingSystem(operatingSystem, platformVersion) {
  if (!operatingSystem || !/^windows 10\b/i.test(operatingSystem)) {
    return operatingSystem;
  }
  const major = Number(String(platformVersion ?? '').split('.')[0]);
  if (Number.isFinite(major) && major >= 13) {
    return operatingSystem.replace(/^windows 10/i, 'Windows 11');
  }
  return operatingSystem;
}

export function parseUserAgent(userAgent) {
  const result = new UAParser(userAgent || '').getResult();
  const browser = [result.browser?.name, result.browser?.version].filter(Boolean).join(' ') || null;
  const operatingSystem = [result.os?.name, result.os?.version].filter(Boolean).join(' ') || null;
  return Object.freeze({
    deviceType: mapDeviceType(result.device?.type),
    operatingSystem,
    browser,
  });
}

function lookupGeo(ip) {
  if (!ip) return { country: null, city: null };
  try {
    const geo = geoip.lookup(ip);
    return { country: geo?.country || null, city: geo?.city || null };
  } catch (error) {
    logger.warn('footprintService: geoip lookup failed', { ip, error: error?.message || String(error) });
    return { country: null, city: null };
  }
}

async function reverseDnsBestEffort(ip) {
  if (!ip) return null;
  try {
    const hostnames = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('reverse DNS timeout')), REVERSE_DNS_TIMEOUT_MS);
      dns.reverse(ip, (err, names) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(names);
      });
    });
    return Array.isArray(hostnames) && hostnames.length > 0 ? hostnames[0] : null;
  } catch {
    return null;
  }
}

/**
 * Capture everything derivable from the incoming HTTP request alone — no client
 * cooperation required. Geolocation coords and timezone come separately from the
 * browser and are never sourced here.
 *
 * @param {import('express').Request} req
 * @returns {Promise<Readonly<{ipAddress: string|null, userAgent: string|null, deviceType: string, operatingSystem: string|null, browser: string|null, country: string|null, city: string|null, hostname: string|null}>>}
 */
export async function captureServerSideFootprint(req) {
  const ipAddress = getClientIp(req);
  const userAgent = req?.headers?.['user-agent'] || null;
  const { deviceType, operatingSystem, browser } = parseUserAgent(userAgent);
  const { country, city } = lookupGeo(ipAddress);
  const hostname = await reverseDnsBestEffort(ipAddress);

  return Object.freeze({ ipAddress, userAgent, deviceType, operatingSystem, browser, country, city, hostname });
}
