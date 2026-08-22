/**
 * Where state is kept, which is what decides whether a countdown survives.
 *
 * The rule under test: the running schedule belongs to the open page
 * (sessionStorage — a reload keeps it, a close drops it), while the settings and
 * the walk log belong to the browser (localStorage).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS_KEY,
  STATE_KEY,
  STATS_KEY,
  STALE_STATE_MS,
  INITIAL_STATE,
  isStaleState,
  loadState,
  saveState,
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
} from '../js/settings.js';

/** Just enough of the Storage interface for the module under test. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    get size() {
      return map.size;
    },
  };
}

/** A blank browser. `session` is what a newly opened tab gets: empty. */
function browser({ local = fakeStorage(), session = fakeStorage() } = {}) {
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  return { local, session };
}

const running = (overrides = {}) => ({
  ...INITIAL_STATE,
  phase: 'waiting',
  nextDueAt: Date.now() + 30 * 60_000,
  stats: { '2026-08-21': { walks: 2, minutes: 24 } },
  ...overrides,
});

test('the schedule goes to the tab, the walk log to the browser', () => {
  const { local, session } = browser();
  const state = running();
  saveState(state);

  const stored = JSON.parse(session.getItem(STATE_KEY));
  assert.equal(stored.phase, 'waiting');
  assert.equal(stored.nextDueAt, state.nextDueAt);
  assert.equal(stored.stats, undefined, 'the walk log has no business in the tab-scoped blob');
  assert.deepEqual(JSON.parse(local.getItem(STATS_KEY)), state.stats);
  assert.equal(local.getItem(STATE_KEY), null, 'nothing schedule-shaped may outlive the tab');
});

test('a reload of the same tab picks the countdown back up', () => {
  browser();
  const state = running();
  saveState(state);

  const reloaded = loadState();
  assert.equal(reloaded.phase, 'waiting');
  assert.equal(reloaded.nextDueAt, state.nextDueAt);
  assert.deepEqual(reloaded.stats, state.stats);
});

test('a newly opened page starts idle, keeping the walk log', () => {
  const { local } = browser();
  saveState(running());

  // Closing the tab is exactly this: the session store goes, the local one stays.
  browser({ local });

  const fresh = loadState();
  assert.equal(fresh.phase, 'idle');
  assert.equal(fresh.nextDueAt, null);
  assert.deepEqual(fresh.stats, { '2026-08-21': { walks: 2, minutes: 24 } }, 'the walks were still walked');
});

test('a schedule nobody has been beating on is not resumed', () => {
  const now = Date.now();
  assert.equal(isStaleState(running({ heartbeatAt: now - 5_000 }), now), false);
  assert.equal(isStaleState(running({ heartbeatAt: now - STALE_STATE_MS - 1 }), now), true);
  assert.equal(isStaleState(running({ heartbeatAt: null }), now), true, 'no stamp, no claim');
  assert.equal(isStaleState({ ...INITIAL_STATE, heartbeatAt: null }, now), false, 'idle is nobody’s countdown');
});

test('a session restore hands back an hour-old countdown, and it is dropped', () => {
  const { session } = browser();
  session.setItem(
    STATE_KEY,
    JSON.stringify({ ...running(), heartbeatAt: Date.now() - 60 * 60_000, stats: undefined }),
  );

  const restored = loadState();
  assert.equal(restored.phase, 'idle');
  assert.equal(session.getItem(STATE_KEY), null, 'the stale blob was cleared, not left to be re-read');
});

test('state written by the old single-store version keeps its walks and loses its schedule', () => {
  const { local } = browser();
  const legacy = { phase: 'waiting', nextDueAt: Date.now() + 30 * 60_000, stats: { '2026-08-20': { walks: 3, minutes: 36 } } };
  local.setItem(STATE_KEY, JSON.stringify(legacy));

  const migrated = loadState();
  assert.equal(migrated.phase, 'idle', 'a countdown from a previous visit is not a countdown now');
  assert.deepEqual(migrated.stats, legacy.stats);
  assert.equal(local.getItem(STATE_KEY), null, 'the old blob is gone for good');
  assert.deepEqual(JSON.parse(local.getItem(STATS_KEY)), legacy.stats);
});

test('settings are untouched by any of this', () => {
  const { local, session } = browser();
  saveSettings({ ...DEFAULT_SETTINGS, intervalMinutes: 45 });
  saveState(running());
  browser({ local });

  assert.equal(loadSettings().intervalMinutes, 45);
  assert.ok(local.getItem(SETTINGS_KEY), 'settings live in the store that outlives the tab');
  assert.ok(session.getItem(STATE_KEY), 'and the schedule in the one that does not');
});

test('storage being unavailable is survivable', () => {
  // Private modes and locked-down profiles throw on the accessor itself.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('denied');
    },
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('denied');
    },
  });

  assert.doesNotThrow(() => saveState(running()));
  assert.deepEqual(loadState(), { ...INITIAL_STATE, stats: {} });
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);

  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
});
