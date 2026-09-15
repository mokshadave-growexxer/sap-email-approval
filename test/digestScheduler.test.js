import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDigestRunAt, createDigestScheduler } from '../src/services/digest/digestScheduler.js';

const AT_10_IST = { hour: 10, minute: 0 };

test('nextDigestRunAt returns today 10:00 IST when now is before it', () => {
  // 2026-09-15T03:00:00Z == 08:30 IST -> next run is 10:00 IST today == 04:30Z
  const now = new Date('2026-09-15T03:00:00Z');
  assert.equal(nextDigestRunAt(now, AT_10_IST).toISOString(), '2026-09-15T04:30:00.000Z');
});

test('nextDigestRunAt rolls to tomorrow when the window has passed (restart-safe skip)', () => {
  // 2026-09-15T05:00:00Z == 10:30 IST -> already past today's 10:00 -> tomorrow 04:30Z
  const now = new Date('2026-09-15T05:00:00Z');
  assert.equal(nextDigestRunAt(now, AT_10_IST).toISOString(), '2026-09-16T04:30:00.000Z');
});

test('nextDigestRunAt honors a configured non-zero minute', () => {
  const now = new Date('2026-09-15T03:00:00Z');
  assert.equal(nextDigestRunAt(now, { hour: 10, minute: 30 }).toISOString(), '2026-09-15T05:00:00.000Z');
});

test('scheduler schedules the next run and re-arms after firing', async () => {
  const timers = [];
  let runs = 0;
  const clockValues = [
    new Date('2026-09-15T03:00:00Z'), // start() -> schedule today 04:30Z (delay 5400000)
    new Date('2026-09-15T04:30:00Z'), // tick -> after run, reschedule tomorrow
  ];
  let clockIdx = 0;

  const scheduler = createDigestScheduler({
    runFn: async () => {
      runs += 1;
    },
    hour: 10,
    minute: 0,
    clock: () => clockValues[Math.min(clockIdx, clockValues.length - 1)],
    setTimeoutFn: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeoutFn: () => {},
    logger: { info() {}, warn() {}, error() {} },
  });

  scheduler.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 5_400_000); // 90 minutes to 04:30Z

  // Fire the tick.
  clockIdx = 1;
  await timers[0].fn();
  assert.equal(runs, 1);
  // Re-armed for the following day.
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delay, 24 * 60 * 60 * 1000);

  scheduler.stop();
});

test('a disabled scheduler never arms a timer', () => {
  const timers = [];
  const scheduler = createDigestScheduler({
    enabled: false,
    runFn: async () => {},
    setTimeoutFn: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  scheduler.start();
  assert.equal(timers.length, 0);
});
