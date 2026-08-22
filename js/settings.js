/**
 * Settings: defaults, annoyance profiles, and persistence.
 * Every read is defensive — a corrupt or half-written value must never stop the
 * page from starting, since the whole point is that it keeps running unattended.
 *
 * Two stores, deliberately: settings and the walk log are yours and belong in
 * localStorage, but the running countdown belongs to the open page. It lives in
 * sessionStorage, which survives a reload of the same tab and dies with it, so
 * closing the page stops the clock instead of leaving one ticking in the dark.
 */

import { clamp, hmToMinutes } from './scheduler.js';

export const SETTINGS_KEY = 'get-moving:settings:v1';
/** The running schedule — sessionStorage, i.e. one open tab's worth. */
export const STATE_KEY = 'get-moving:state:v1';
/** The walk log — localStorage, so it outlives the tab it was earned in. */
export const STATS_KEY = 'get-moving:stats:v1';

/**
 * How stale the schedule's heartbeat may be before we treat it as someone else's.
 * A tab that is merely hidden still beats about once a minute (its timers get
 * clamped), so the window has to clear that comfortably; anything beyond it means
 * the page was not actually open — a browser restore handing back the
 * sessionStorage of a tab that was closed hours ago, say — and the clock starts fresh.
 */
export const STALE_STATE_MS = 2 * 60_000;

export const DEFAULT_SETTINGS = {
  intervalMinutes: 60,
  walkMinutes: 12,
  annoyance: 'nagging',
  volume: 0.6,
  snoozeMinutes: 5,
  quietHoursEnabled: false,
  quietFrom: '22:00',
  quietTo: '07:00',
  sitNudgeEnabled: true,
  preciseTimers: false,
};

/**
 * How hard each level pushes. `maxRepeats` counts alarms including the first,
 * so "gentle" is a single chime and nothing more. `animateTitle` is what sets the
 * tab name scrolling while the nudge is up.
 */
export const ANNOYANCE_PROFILES = {
  gentle: {
    label: 'Gentle',
    blurb: 'One soft chime and a quiet title change. Easy to miss — which is the point.',
    requireInteraction: false,
    renotify: false,
    repeatSeconds: 0,
    maxRepeats: 1,
    volumeRamp: false,
    animateTitle: false,
    overlay: 'none',
    snoozeCapMinutes: Infinity,
    maxSnoozes: Infinity,
  },
  nagging: {
    label: 'Nagging',
    blurb: 'Sticky notification, a chime every 30 s (ten times), a tab title that scrolls past and a red icon.',
    requireInteraction: true,
    renotify: false,
    repeatSeconds: 30,
    maxRepeats: 10,
    volumeRamp: false,
    animateTitle: true,
    overlay: 'dismissible',
    snoozeCapMinutes: Infinity,
    maxSnoozes: Infinity,
  },
  infuriating: {
    label: 'Infuriating',
    blurb: 'Re-fired notification and a louder chime every 15 s, forever. Scrolling tab title, blocking overlay, snooze capped at 5 min, twice per cycle.',
    requireInteraction: true,
    renotify: true,
    repeatSeconds: 15,
    maxRepeats: Infinity,
    volumeRamp: true,
    animateTitle: true,
    overlay: 'blocking',
    snoozeCapMinutes: 5,
    maxSnoozes: 2,
  },
};

export function profileFor(settings) {
  return ANNOYANCE_PROFILES[settings.annoyance] ?? ANNOYANCE_PROFILES.nagging;
}

/** Coerce anything into a usable settings object. Unknown keys are dropped. */
export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const number = (key, min, max) => {
    const value = Number(input[key]);
    return Number.isFinite(value) ? clamp(value, min, max) : DEFAULT_SETTINGS[key];
  };
  const bool = (key) => (typeof input[key] === 'boolean' ? input[key] : DEFAULT_SETTINGS[key]);
  const time = (key) => (hmToMinutes(input[key]) === null ? DEFAULT_SETTINGS[key] : input[key]);

  return {
    intervalMinutes: Math.round(number('intervalMinutes', 1, 24 * 60)),
    walkMinutes: Math.round(number('walkMinutes', 1, 12 * 60)),
    annoyance: input.annoyance in ANNOYANCE_PROFILES ? input.annoyance : DEFAULT_SETTINGS.annoyance,
    volume: number('volume', 0, 1),
    snoozeMinutes: Math.round(number('snoozeMinutes', 1, 120)),
    quietHoursEnabled: bool('quietHoursEnabled'),
    quietFrom: time('quietFrom'),
    quietTo: time('quietTo'),
    sitNudgeEnabled: bool('sitNudgeEnabled'),
    preciseTimers: bool('preciseTimers'),
  };
}

/** Accessing storage can itself throw when the browser has it disabled. */
function store(kind) {
  try {
    return kind === 'session' ? sessionStorage : localStorage;
  } catch {
    return null;
  }
}

function readJson(kind, key) {
  try {
    const raw = store(kind)?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(kind, key, value) {
  try {
    store(kind)?.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode, quota, or storage disabled — the app still works for this session */
  }
}

function removeKey(kind, key) {
  try {
    store(kind)?.removeItem(key);
  } catch {
    /* nothing to remove */
  }
}

export function loadSettings() {
  return normalizeSettings(readJson('local', SETTINGS_KEY));
}

export function saveSettings(settings) {
  writeJson('local', SETTINGS_KEY, settings);
}

export const INITIAL_STATE = {
  phase: 'idle', // idle | waiting | due | paused
  nextDueAt: null,
  dueSince: null, // when the current nudge became due, after miss re-anchoring
  walkEndsAt: null,
  // What was left of the interval / of the walk when Pause was pressed, so that
  // Resume continues the countdown instead of starting a new one.
  pausedRemainingMs: null,
  pausedWalkRemainingMs: null,
  snoozesUsed: 0,
  lastAlarmStep: -1,
  // Stamped on every write, so a schedule handed back by a browser session
  // restore can be told apart from one belonging to a page that never closed.
  heartbeatAt: null,
  stats: {},
};

export function normalizeState(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const phases = ['idle', 'waiting', 'due', 'paused'];
  const timestamp = (key) => (Number.isFinite(Number(input[key])) && input[key] !== null ? Number(input[key]) : null);
  const duration = (key) => {
    const value = timestamp(key);
    return value === null ? null : Math.max(0, value);
  };
  return {
    phase: phases.includes(input.phase) ? input.phase : 'idle',
    nextDueAt: timestamp('nextDueAt'),
    dueSince: timestamp('dueSince'),
    walkEndsAt: timestamp('walkEndsAt'),
    pausedRemainingMs: duration('pausedRemainingMs'),
    pausedWalkRemainingMs: duration('pausedWalkRemainingMs'),
    snoozesUsed: Number.isFinite(Number(input.snoozesUsed)) ? Number(input.snoozesUsed) : 0,
    lastAlarmStep: Number.isFinite(Number(input.lastAlarmStep)) ? Number(input.lastAlarmStep) : -1,
    heartbeatAt: timestamp('heartbeatAt'),
    stats: input.stats && typeof input.stats === 'object' ? input.stats : {},
  };
}

/** True when a stored schedule cannot have come from a page that stayed open. */
export function isStaleState(state, nowMs = Date.now()) {
  if (state.phase === 'idle') return false;
  return !Number.isFinite(state.heartbeatAt) || nowMs - state.heartbeatAt > STALE_STATE_MS;
}

/**
 * The walk log, with a one-off lift out of the old combined state blob so the
 * counts of anyone who used the app before the split are not thrown away.
 */
function loadStats() {
  const stored = readJson('local', STATS_KEY);
  if (stored && typeof stored === 'object') return stored;

  const legacy = readJson('local', STATE_KEY);
  // The rest of that blob is a schedule from a page that is long closed; dropping
  // the key is the point, so it can never be resurrected as a running countdown.
  removeKey('local', STATE_KEY);
  const stats = legacy?.stats && typeof legacy.stats === 'object' ? legacy.stats : {};
  writeJson('local', STATS_KEY, stats);
  return stats;
}

/**
 * Rebuild the state a page starts with: the walk log always, and the schedule only
 * if this very tab left one behind recently. A tab that was closed — or a schedule
 * a browser restore is trying to hand back — starts over from idle.
 */
export function loadState() {
  const stats = loadStats();
  const stored = normalizeState(readJson('session', STATE_KEY));
  if (isStaleState(stored)) {
    removeKey('session', STATE_KEY);
    return { ...INITIAL_STATE, stats };
  }
  return { ...stored, stats };
}

export function saveState(state, nowMs = Date.now()) {
  const { stats, ...schedule } = state;
  writeJson('session', STATE_KEY, { ...schedule, heartbeatAt: nowMs });
  writeJson('local', STATS_KEY, stats ?? {});
}
