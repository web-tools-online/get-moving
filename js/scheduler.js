/**
 * Pure scheduling logic for Get Moving. No DOM, no storage, no side effects —
 * everything here is a plain function of (state, settings, now) so it can be
 * unit-tested under `node --test`.
 *
 * Timing model: walking counts toward the interval. Acknowledging a nudge
 * schedules the next one exactly one interval later, so the cadence stays
 * anchored (09:00 -> ack -> 10:00 -> ack -> 11:00) instead of drifting.
 */

export const MINUTE = 60_000;

/** "22:00" -> 1320. Returns null for anything unparseable. */
export function hmToMinutes(hm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? '').trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function minutesOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

/** True when `ts` falls inside the configured quiet window (which may wrap midnight). */
export function isQuiet(ts, settings) {
  if (!settings.quietHoursEnabled) return false;
  const from = hmToMinutes(settings.quietFrom);
  const to = hmToMinutes(settings.quietTo);
  if (from === null || to === null || from === to) return false;
  const m = minutesOfDay(ts);
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** The next moment at or after `ts` when the quiet window ends. */
export function quietEnd(ts, settings) {
  const to = hmToMinutes(settings.quietTo);
  if (to === null) return ts;
  const d = new Date(ts);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(to / 60), to % 60, 0, 0);
  if (end.getTime() <= ts) end.setDate(end.getDate() + 1);
  return end.getTime();
}

/** Push a due time out of the quiet window, if it landed inside one. */
export function applyQuietHours(ts, settings) {
  return isQuiet(ts, settings) ? quietEnd(ts, settings) : ts;
}

/** Next nudge time given that a cycle just started (or was acknowledged) at `fromMs`. */
export function nextDueFrom(fromMs, settings) {
  return applyQuietHours(fromMs + settings.intervalMinutes * MINUTE, settings);
}

/**
 * How late a nudge has to be before we assume the machine was asleep. Past this
 * point we re-anchor to "now" rather than pretending it has been screaming for
 * six hours.
 */
export function isMissed(nextDueAt, nowMs, settings) {
  return nowMs - nextDueAt > 2 * settings.intervalMinutes * MINUTE;
}

/**
 * The due time to escalate from: the real one normally, or `nowMs` when the nudge
 * is so late that the machine was clearly suspended.
 */
export function effectiveDueAt(nextDueAt, nowMs, settings) {
  return isMissed(nextDueAt, nowMs, settings) ? nowMs : nextDueAt;
}

/**
 * How many times the alarm should have re-fired by `nowMs`, capped by the
 * annoyance profile. Step 0 is the first alarm.
 */
export function escalationStep(dueAt, nowMs, profile) {
  if (!profile.repeatSeconds) return 0;
  const elapsed = Math.max(0, nowMs - dueAt);
  const step = Math.floor(elapsed / (profile.repeatSeconds * 1000));
  return Math.min(step, profile.maxRepeats - 1);
}

/** Alarm volume for a given escalation step. Ramps only under "infuriating". */
export function volumeForStep(baseVolume, step, profile) {
  if (!profile.volumeRamp) return clamp(baseVolume, 0, 1);
  return clamp(baseVolume * (1 + 0.2 * step), 0, 1);
}

/**
 * Work out a snooze. Returns `allowed: false` when the annoyance profile has run
 * out of patience, so the caller can tell the user why the button did nothing.
 */
export function planSnooze(nowMs, settings, profile, snoozesUsed) {
  if (snoozesUsed >= profile.maxSnoozes) {
    return { allowed: false, reason: 'no-snoozes-left', until: null, snoozesUsed };
  }
  const minutes = Math.min(settings.snoozeMinutes, profile.snoozeCapMinutes);
  return {
    allowed: true,
    reason: null,
    until: applyQuietHours(nowMs + minutes * MINUTE, settings),
    minutes,
    snoozesUsed: snoozesUsed + 1,
  };
}

/** Local-date key for the stats log, e.g. "2026-08-21". */
export function dayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const STATS_RETENTION_DAYS = 14;

/** Record a walk, returning a new stats object pruned to the retention window. */
export function addWalk(stats, ts, minutes) {
  const key = dayKey(ts);
  const previous = stats[key] ?? { walks: 0, minutes: 0 };
  const updated = {
    ...stats,
    [key]: { walks: previous.walks + 1, minutes: previous.minutes + minutes },
  };
  return pruneStats(updated, ts);
}

export function pruneStats(stats, ts) {
  const cutoff = new Date(ts);
  cutoff.setDate(cutoff.getDate() - (STATS_RETENTION_DAYS - 1));
  const cutoffKey = dayKey(cutoff.getTime());
  const pruned = {};
  for (const [key, value] of Object.entries(stats)) {
    if (key >= cutoffKey) pruned[key] = value;
  }
  return pruned;
}

export function statsForDay(stats, ts) {
  return stats[dayKey(ts)] ?? { walks: 0, minutes: 0 };
}

/** The last `days` days of stats, oldest first, for the little bar strip. */
export function recentDays(stats, ts, days = 7) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(ts);
    d.setDate(d.getDate() - i);
    const key = dayKey(d.getTime());
    out.push({ key, ...(stats[key] ?? { walks: 0, minutes: 0 }) });
  }
  return out;
}

/** "1:04:09" / "4:09" — for the countdown readout. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** "in 42 min" / "3 h 5 min" — for notification bodies and secondary text. */
export function formatApprox(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
