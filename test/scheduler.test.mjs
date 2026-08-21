import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MINUTE,
  hmToMinutes,
  isQuiet,
  quietEnd,
  applyQuietHours,
  nextDueFrom,
  isMissed,
  effectiveDueAt,
  escalationStep,
  volumeForStep,
  planSnooze,
  dayKey,
  addWalk,
  pruneStats,
  statsForDay,
  recentDays,
  formatDuration,
  formatApprox,
} from '../js/scheduler.js';

import { ANNOYANCE_PROFILES, DEFAULT_SETTINGS, normalizeSettings, normalizeState } from '../js/settings.js';

/** Local-time helper so tests read like wall-clock times regardless of the runner's zone. */
const at = (h, m = 0, day = 21) => new Date(2026, 7, day, h, m, 0, 0).getTime();

const settings = { ...DEFAULT_SETTINGS };

test('hmToMinutes parses and rejects', () => {
  assert.equal(hmToMinutes('22:00'), 1320);
  assert.equal(hmToMinutes('7:05'), 425);
  assert.equal(hmToMinutes('24:00'), null);
  assert.equal(hmToMinutes('22:60'), null);
  assert.equal(hmToMinutes('nonsense'), null);
  assert.equal(hmToMinutes(undefined), null);
});

test('acknowledging schedules exactly one interval later', () => {
  const ack = at(9);
  assert.equal(nextDueFrom(ack, settings), at(10));
});

test('the cadence stays anchored across cycles', () => {
  // 09:00 nudge -> ack -> 10:00 -> ack -> 11:00, per the agreed timing model.
  let due = nextDueFrom(at(9), settings);
  assert.equal(due, at(10));
  due = nextDueFrom(due, settings);
  assert.equal(due, at(11));
});

test('a non-60 interval still lands where you expect', () => {
  const custom = { ...settings, intervalMinutes: 45 };
  assert.equal(nextDueFrom(at(9), custom), at(9, 45));
});

test('quiet hours: a plain daytime window', () => {
  const quiet = { ...settings, quietHoursEnabled: true, quietFrom: '12:00', quietTo: '13:00' };
  assert.equal(isQuiet(at(12, 30), quiet), true);
  assert.equal(isQuiet(at(11, 59), quiet), false);
  assert.equal(isQuiet(at(13, 0), quiet), false, 'the end of the window is exclusive');
});

test('quiet hours: a window wrapping midnight', () => {
  const quiet = { ...settings, quietHoursEnabled: true, quietFrom: '22:00', quietTo: '07:00' };
  assert.equal(isQuiet(at(23, 30), quiet), true);
  assert.equal(isQuiet(at(3, 0), quiet), true);
  assert.equal(isQuiet(at(7, 0), quiet), false);
  assert.equal(isQuiet(at(12, 0), quiet), false);
});

test('quiet hours are ignored when disabled, or when the window is empty', () => {
  assert.equal(isQuiet(at(23, 30), { ...settings, quietFrom: '22:00', quietTo: '07:00' }), false);
  const empty = { ...settings, quietHoursEnabled: true, quietFrom: '22:00', quietTo: '22:00' };
  assert.equal(isQuiet(at(23, 30), empty), false);
});

test('a nudge due inside quiet hours is deferred to the end of the window', () => {
  const quiet = { ...settings, quietHoursEnabled: true, quietFrom: '22:00', quietTo: '07:00' };
  // Acknowledged at 23:10 -> would be due 00:10, which is still quiet -> 07:00 next day.
  assert.equal(nextDueFrom(at(23, 10), quiet), at(7, 0, 22));
});

test('quietEnd rolls to tomorrow when the boundary already passed today', () => {
  const quiet = { ...settings, quietHoursEnabled: true, quietFrom: '22:00', quietTo: '07:00' };
  assert.equal(quietEnd(at(23, 0), quiet), at(7, 0, 22));
  assert.equal(quietEnd(at(3, 0), quiet), at(7, 0, 21));
});

test('applyQuietHours leaves a due time outside the window alone', () => {
  const quiet = { ...settings, quietHoursEnabled: true, quietFrom: '22:00', quietTo: '07:00' };
  assert.equal(applyQuietHours(at(15, 0), quiet), at(15, 0));
});

test('miss detection triggers only past twice the interval', () => {
  const due = at(9);
  assert.equal(isMissed(due, due + 90 * MINUTE, settings), false);
  assert.equal(isMissed(due, due + 121 * MINUTE, settings), true);
});

test('a missed nudge re-anchors to now instead of escalating from hours ago', () => {
  const due = at(9);
  const wokeUp = due + 6 * 60 * MINUTE;
  assert.equal(effectiveDueAt(due, wokeUp, settings), wokeUp);
  const merelyLate = due + 30 * MINUTE;
  assert.equal(effectiveDueAt(due, merelyLate, settings), due);
});

test('escalation steps follow the profile cadence and cap', () => {
  const nagging = ANNOYANCE_PROFILES.nagging;
  const due = at(9);
  assert.equal(escalationStep(due, due, nagging), 0);
  assert.equal(escalationStep(due, due + 29_000, nagging), 0);
  assert.equal(escalationStep(due, due + 30_000, nagging), 1);
  assert.equal(escalationStep(due, due + 10 * MINUTE, nagging), 9, 'capped at maxRepeats - 1');
});

test('gentle never repeats; infuriating never stops', () => {
  const due = at(9);
  assert.equal(escalationStep(due, due + 60 * MINUTE, ANNOYANCE_PROFILES.gentle), 0);
  assert.equal(escalationStep(due, due + 60 * MINUTE, ANNOYANCE_PROFILES.infuriating), 240);
});

test('volume ramps only under infuriating, and never past 1', () => {
  assert.equal(volumeForStep(0.5, 5, ANNOYANCE_PROFILES.nagging), 0.5);
  assert.equal(volumeForStep(0.5, 1, ANNOYANCE_PROFILES.infuriating), 0.6);
  assert.equal(volumeForStep(0.9, 20, ANNOYANCE_PROFILES.infuriating), 1);
});

test('snooze is capped and rationed under infuriating', () => {
  const generous = { ...settings, snoozeMinutes: 30 };
  const relaxed = planSnooze(at(9), generous, ANNOYANCE_PROFILES.nagging, 4);
  assert.equal(relaxed.allowed, true);
  assert.equal(relaxed.until, at(9, 30));

  const capped = planSnooze(at(9), generous, ANNOYANCE_PROFILES.infuriating, 0);
  assert.equal(capped.minutes, 5, 'infuriating caps the snooze length');
  assert.equal(capped.until, at(9, 5));
  assert.equal(capped.snoozesUsed, 1);

  const exhausted = planSnooze(at(9), generous, ANNOYANCE_PROFILES.infuriating, 2);
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.reason, 'no-snoozes-left');
  assert.equal(exhausted.until, null);
});

test('a snooze landing in quiet hours is deferred too', () => {
  const quiet = { ...settings, quietHoursEnabled: true, quietFrom: '22:00', quietTo: '07:00', snoozeMinutes: 10 };
  const plan = planSnooze(at(21, 55), quiet, ANNOYANCE_PROFILES.nagging, 0);
  assert.equal(plan.until, at(7, 0, 22));
});

test('dayKey is local-date based and zero padded', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 30).getTime()), '2026-01-05');
});

test('walks accumulate per local day', () => {
  let stats = {};
  stats = addWalk(stats, at(9), 12);
  stats = addWalk(stats, at(10), 12);
  assert.deepEqual(statsForDay(stats, at(11)), { walks: 2, minutes: 24 });
  stats = addWalk(stats, at(9, 0, 22), 15);
  assert.deepEqual(statsForDay(stats, at(9, 0, 22)), { walks: 1, minutes: 15 });
  assert.deepEqual(statsForDay(stats, at(9)), { walks: 2, minutes: 24 }, 'yesterday is untouched');
});

test('stats older than the retention window are pruned', () => {
  const old = dayKey(at(9, 0, 1));
  const stats = pruneStats({ [old]: { walks: 3, minutes: 36 }, [dayKey(at(9))]: { walks: 1, minutes: 12 } }, at(9));
  assert.equal(stats[old], undefined);
  assert.deepEqual(stats[dayKey(at(9))], { walks: 1, minutes: 12 });
});

test('recentDays returns a padded, ordered strip', () => {
  const stats = addWalk({}, at(9), 12);
  const strip = recentDays(stats, at(9), 7);
  assert.equal(strip.length, 7);
  assert.equal(strip.at(-1).key, dayKey(at(9)));
  assert.equal(strip.at(-1).minutes, 12);
  assert.equal(strip[0].minutes, 0);
});

test('durations format for the countdown and for prose', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(-5000), '0:00');
  assert.equal(formatDuration(65_000), '1:05');
  assert.equal(formatDuration(3_849_000), '1:04:09');
  assert.equal(formatApprox(59 * MINUTE), '59 min');
  assert.equal(formatApprox(60 * MINUTE), '1 h');
  assert.equal(formatApprox(185 * MINUTE), '3 h 5 min');
});

test('settings are clamped and bad values fall back to defaults', () => {
  const normalized = normalizeSettings({
    intervalMinutes: 0,
    walkMinutes: '20',
    annoyance: 'apocalyptic',
    volume: 5,
    quietFrom: '99:99',
    sitNudgeEnabled: 'yes',
  });
  assert.equal(normalized.intervalMinutes, 1);
  assert.equal(normalized.walkMinutes, 20);
  assert.equal(normalized.annoyance, 'nagging');
  assert.equal(normalized.volume, 1);
  assert.equal(normalized.quietFrom, DEFAULT_SETTINGS.quietFrom);
  assert.equal(normalized.sitNudgeEnabled, DEFAULT_SETTINGS.sitNudgeEnabled);
});

test('a corrupt saved state degrades to idle rather than throwing', () => {
  const state = normalizeState({ phase: 'walking-on-sunshine', nextDueAt: 'soon', stats: null });
  assert.equal(state.phase, 'idle');
  assert.equal(state.nextDueAt, null);
  assert.deepEqual(state.stats, {});
});

test('a walk longer than the interval must not be interrupted by the next nudge', () => {
  // The app clamps `nextDueAt` to the end of the walk; this pins the arithmetic
  // that clamp depends on.
  const marathon = { ...settings, intervalMinutes: 20, walkMinutes: 30 };
  const ack = at(9);
  const due = nextDueFrom(ack, marathon);
  const walkEnds = ack + marathon.walkMinutes * MINUTE;
  assert.ok(due < walkEnds, 'without a clamp the nudge would land mid-walk');
  assert.equal(Math.max(due, walkEnds), at(9, 30));
});
