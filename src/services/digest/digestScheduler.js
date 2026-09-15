import logger from '../../config/logger.js';
import { config } from '../../config/index.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The next instant at HH:MM IST strictly after `now`. Computed against the fixed
 * IST offset so it is correct regardless of the server's own timezone. If the
 * window has already passed today it rolls to tomorrow — so a process that
 * restarts after the send time simply waits for the next day rather than firing
 * a late (or duplicate) digest.
 *
 * @param {Date} now
 * @param {{ hour: number, minute: number }} at
 * @returns {Date}
 */
export function nextDigestRunAt(now, { hour, minute }) {
  const nowMs = now.getTime();
  const istWall = new Date(nowMs + IST_OFFSET_MS);
  const year = istWall.getUTCFullYear();
  const month = istWall.getUTCMonth();
  const day = istWall.getUTCDate();

  // Date.UTC(...) treats the IST wall-clock fields as if they were UTC; subtract
  // the offset to recover the real UTC instant of that IST wall time.
  let targetMs = Date.UTC(year, month, day, hour, minute, 0, 0) - IST_OFFSET_MS;
  if (targetMs <= nowMs) {
    targetMs += ONE_DAY_MS;
  }
  return new Date(targetMs);
}

/**
 * A once-a-day scheduler that fires `runFn` at HH:MM IST. Single-timer: it arms
 * one timeout to the next run, then re-arms after each firing. All time sources
 * are injectable so the timing is unit-testable without real clocks.
 *
 * @param {{
 *   runFn: () => Promise<void>,
 *   enabled?: boolean,
 *   hour?: number,
 *   minute?: number,
 *   clock?: () => Date,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   logger?: object,
 * }} deps
 */
export function createDigestScheduler({
  runFn,
  enabled = config.digest.enabled,
  hour = config.digest.sendHourIst,
  minute = config.digest.sendMinuteIst,
  clock = () => new Date(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger: log = logger,
} = {}) {
  let timer = null;

  function armNext() {
    const now = clock();
    const runAt = nextDigestRunAt(now, { hour, minute });
    const delay = Math.max(0, runAt.getTime() - now.getTime());
    timer = setTimeoutFn(onTick, delay);
    log.info('digestScheduler: next digest scheduled', { runAt: runAt.toISOString(), delayMs: delay });
  }

  async function onTick() {
    try {
      await runFn();
    } catch (error) {
      log.error('digestScheduler: digest run failed', { error: error?.message || String(error) });
    } finally {
      armNext();
    }
  }

  function start() {
    if (!enabled) {
      log.info('digestScheduler: disabled (DIGEST_ENABLED=false); not scheduling');
      return;
    }
    if (timer) {
      return;
    }
    armNext();
  }

  function stop() {
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
      log.info('digestScheduler: stopped');
    }
  }

  return { start, stop };
}
