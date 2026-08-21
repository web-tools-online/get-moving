/**
 * Settings: defaults, annoyance profiles, and localStorage persistence.
 * Every read is defensive — a corrupt or half-written value must never stop the
 * page from starting, since the whole point is that it keeps running unattended.
 */

import { clamp, hmToMinutes } from './scheduler.js';

export const SETTINGS_KEY = 'get-moving:settings:v1';
export const STATE_KEY = 'get-moving:state:v1';

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

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode, quota, or storage disabled — the app still works for this session */
  }
}

export function loadSettings() {
  return normalizeSettings(readJson(SETTINGS_KEY));
}

export function saveSettings(settings) {
  writeJson(SETTINGS_KEY, settings);
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
    stats: input.stats && typeof input.stats === 'object' ? input.stats : {},
  };
}

export function loadState() {
  return normalizeState(readJson(STATE_KEY));
}

export function saveState(state) {
  writeJson(STATE_KEY, state);
}
