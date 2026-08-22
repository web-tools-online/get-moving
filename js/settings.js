/**
 * Settings: defaults, annoyance profiles, and persistence.
 * Every read is defensive — a corrupt or half-written value must never stop the
 * page from starting, since the whole point is that it keeps running unattended.
 *
 * Everything the app keeps lives in localStorage, including the running countdown:
 * open the app a second time and both pages are meant to be looking at the same
 * clock, not at two of them. What localStorage cannot say on its own is whether
 * anyone is still watching, and a countdown is supposed to stop when the last page
 * closes. So each open page registers itself under `PAGES_KEY` and strikes itself
 * off as it goes away, and each page's own id is kept in sessionStorage, which
 * survives its reloads and dies with it. A schedule is picked up only when another
 * page is open right now, or when this very page is coming back from a reload —
 * otherwise it is a countdown nobody is running, and the clock starts fresh.
 */

import { clamp, hmToMinutes } from './scheduler.js';

export const SETTINGS_KEY = 'get-moving:settings:v1';
/** The running schedule — localStorage, shared by every page that has the app open. */
export const SCHEDULE_KEY = 'get-moving:schedule:v1';
/** Who is open right now: `{ [pageId]: heartbeatMs }`, in localStorage. */
export const PAGES_KEY = 'get-moving:pages:v1';
/** This page's own id — sessionStorage, so a reload comes back as the same page. */
export const PAGE_ID_KEY = 'get-moving:page:v1';
/** The walk log — localStorage, so it outlives the page it was earned in. */
export const STATS_KEY = 'get-moving:stats:v1';
/** Pre-sharing key: a combined blob in localStorage, then a per-tab schedule in sessionStorage. */
export const LEGACY_STATE_KEY = 'get-moving:state:v1';

/**
 * How stale a heartbeat — a page's or the schedule's — may be before we stop
 * believing it. A hidden page still beats about once a minute (its timers get
 * clamped), so the window has to clear that comfortably; anything beyond it means
 * nothing was actually open — a browser restore handing back the page id of a tab
 * that was closed hours ago, say — and the clock starts fresh.
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

function readText(kind, key) {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeText(kind, key, value) {
  try {
    store(kind)?.setItem(key, value);
  } catch {
    /* storage disabled — this page just cannot be recognised after a reload */
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
  // Stamped on every write: it dates the schedule, and it is what lets a page
  // tell a countdown another page is still running from one nobody is.
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
export function loadStats() {
  const stored = readJson('local', STATS_KEY);
  if (stored && typeof stored === 'object') return stored;

  const legacy = readJson('local', LEGACY_STATE_KEY);
  // The rest of that blob is a schedule from a page that is long closed; dropping
  // the key is the point, so it can never be resurrected as a running countdown.
  removeKey('local', LEGACY_STATE_KEY);
  const stats = legacy?.stats && typeof legacy.stats === 'object' ? legacy.stats : {};
  writeJson('local', STATS_KEY, stats);
  return stats;
}

export function saveStats(stats) {
  writeJson('local', STATS_KEY, stats ?? {});
}

/* ------------------------------------------------------- who has the app open */

function newPageId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* fall through to the cheap one */
  }
  return `p${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The open pages, minus any whose heartbeat has gone quiet for too long. */
function readPages(nowMs) {
  const raw = readJson('local', PAGES_KEY);
  const pages = {};
  if (raw && typeof raw === 'object') {
    for (const [id, beat] of Object.entries(raw)) {
      const at = Number(beat);
      if (Number.isFinite(at) && nowMs - at <= STALE_STATE_MS) pages[id] = at;
    }
  }
  return pages;
}

/** True when some page other than this one has the app open right now. */
export function hasOpenPage(exceptId, nowMs = Date.now()) {
  return Object.keys(readPages(nowMs)).some((id) => id !== exceptId);
}

/** Register this page as open. Also the heartbeat — it is the same write. */
export function markPageOpen(id, nowMs = Date.now()) {
  writeJson('local', PAGES_KEY, { ...readPages(nowMs), [id]: nowMs });
}

/**
 * Strike this page off, which is what tells a close from a reload: both drop the
 * page out of the register, but only a reload brings back the id in sessionStorage.
 */
export function markPageClosed(id, nowMs = Date.now()) {
  const pages = readPages(nowMs);
  delete pages[id];
  writeJson('local', PAGES_KEY, pages);
}

/* -------------------------------------------------------------- the schedule */

/** The shared schedule as it stands in storage, or null when there is none worth having. */
export function readSchedule(nowMs = Date.now()) {
  const stored = readJson('local', SCHEDULE_KEY);
  if (!stored) return null;
  const schedule = normalizeState(stored);
  return isStaleState(schedule, nowMs) ? null : schedule;
}

export function saveSchedule(state, nowMs = Date.now()) {
  const { stats, ...schedule } = state;
  writeJson('local', SCHEDULE_KEY, { ...schedule, heartbeatAt: nowMs });
}

/**
 * Opening the app: take an id, join the countdown if there is a live one to join,
 * and register as open.
 *
 * "Live" means a page other than this one is open right now, or this is the same
 * page coming back from a reload. A schedule with neither behind it belonged to
 * pages that are all gone — or is one a browser session restore is trying to hand
 * back — and it is dropped rather than resumed.
 */
export function openPage(nowMs = Date.now()) {
  const previousId = readText('session', PAGE_ID_KEY);
  const reloaded = typeof previousId === 'string' && previousId.length > 0;
  const id = reloaded ? previousId : newPageId();
  writeText('session', PAGE_ID_KEY, id);
  // The per-tab schedule the version before this one kept here. Nothing reads it any
  // more: a page arriving from that version joins the shared countdown or starts one.
  removeKey('session', LEGACY_STATE_KEY);

  const shared = readSchedule(nowMs);
  const join = shared !== null && (reloaded || hasOpenPage(id, nowMs));
  markPageOpen(id, nowMs);

  const stats = loadStats();
  if (!join) {
    removeKey('local', SCHEDULE_KEY);
    return { id, state: { ...INITIAL_STATE, stats } };
  }
  return { id, state: { ...shared, stats } };
}
