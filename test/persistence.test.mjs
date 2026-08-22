/**
 * Where state is kept, which is what decides whether a countdown survives.
 *
 * The rule under test: the countdown belongs to the app, not to one page of it —
 * open the app a second time and both pages run the same clock — and it lasts as
 * long as some open page keeps beating it. Settings and the walk log are the
 * browser's and outlive every page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS_KEY,
  SCHEDULE_KEY,
  STATS_KEY,
  LEGACY_STATE_KEY,
  STALE_STATE_MS,
  INITIAL_STATE,
  isStaleState,
  loadState,
  readSchedule,
  saveSchedule,
  saveStats,
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

/**
 * One browser, with pages inside it: localStorage is shared by all of them,
 * sessionStorage belongs to a page and dies with it.
 */
function browser() {
  const local = fakeStorage();
  const focus = (session = fakeStorage()) => {
    globalThis.localStorage = local;
    globalThis.sessionStorage = session;
    return session;
  };
  return {
    local,
    /** Open the app in a page of this browser, and hand back what it opens with. */
    open(session) {
      return { session: focus(session), state: loadState() };
    },
    /** Reach into this browser's storage without opening the app in it. */
    focus,
  };
}

const DUE_AT = Date.now() + 30 * 60_000;
const WALKS = { '2026-08-21': { walks: 2, minutes: 24 } };

const running = (overrides = {}) => ({
  ...INITIAL_STATE,
  phase: 'waiting',
  nextDueAt: DUE_AT,
  stats: WALKS,
  ...overrides,
});

test('the schedule goes to the browser, and the page keeps none of it', () => {
  const app = browser();
  const page = app.open();
  saveSchedule(running());
  saveStats(WALKS);

  const stored = JSON.parse(app.local.getItem(SCHEDULE_KEY));
  assert.equal(stored.phase, 'waiting');
  assert.equal(stored.nextDueAt, DUE_AT);
  assert.equal(stored.stats, undefined, 'the walk log has no business in the schedule blob');
  assert.deepEqual(JSON.parse(app.local.getItem(STATS_KEY)), WALKS);
  assert.equal(page.session.size, 0, 'nothing a second page would need is tied to the first one');
});

test('a second page joins the countdown the first one is already running', () => {
  const app = browser();
  app.open();
  saveSchedule(running());

  const second = app.open();
  assert.equal(second.state.phase, 'waiting');
  assert.equal(second.state.nextDueAt, DUE_AT, 'the same clock, not one of its own');
  assert.deepEqual(second.state.stats, {}, 'no walks logged yet in this browser');
});

test('the first page to open starts idle', () => {
  const app = browser();
  assert.equal(app.open().state.phase, 'idle');
});

test('a reload of the same page picks the countdown back up', () => {
  const app = browser();
  const page = app.open();
  saveSchedule(running());
  saveStats(WALKS);

  const reloaded = app.open(page.session);
  assert.equal(reloaded.state.phase, 'waiting');
  assert.equal(reloaded.state.nextDueAt, DUE_AT);
  assert.deepEqual(reloaded.state.stats, WALKS);
});

test('a page whose beat is old but still coming is joined all the same', () => {
  // Which is any page in a background tab: its timers get clamped to about one a
  // minute, and a page opened in between must still find the countdown.
  const now = Date.now();
  const app = browser();
  app.focus();
  saveSchedule(running(), now - 61_000);

  assert.equal(app.open().state.phase, 'waiting', 'a countdown still being beaten was passed over');
});

test('a countdown nothing is beating any more is not resumed', () => {
  // The last page closed, or a browser session restore is handing back the tabs of
  // one that stopped hours ago. Either way nothing has stamped the schedule since.
  const now = Date.now();
  const app = browser();
  app.focus();
  saveSchedule(running(), now - STALE_STATE_MS - 1);
  saveStats(WALKS);

  const later = app.open();
  assert.equal(later.state.phase, 'idle');
  assert.equal(later.state.nextDueAt, null);
  assert.equal(readSchedule(), null, 'the stale blob was cleared, not left to be re-read');
  assert.equal(app.local.getItem(SCHEDULE_KEY), null);
  assert.deepEqual(later.state.stats, WALKS, 'the walks were still walked');
});

test('a schedule nobody has been beating on is not resumed', () => {
  const now = Date.now();
  assert.equal(isStaleState(running({ heartbeatAt: now - 5_000 }), now), false);
  assert.equal(isStaleState(running({ heartbeatAt: now - STALE_STATE_MS - 1 }), now), true);
  assert.equal(isStaleState(running({ heartbeatAt: null }), now), true, 'no stamp, no claim');
  assert.equal(isStaleState({ ...INITIAL_STATE, heartbeatAt: null }, now), false, 'idle is nobody’s countdown');
});

test('state written by the old single-store version keeps its walks and loses its schedule', () => {
  const app = browser();
  const legacy = { phase: 'waiting', nextDueAt: DUE_AT, stats: { '2026-08-20': { walks: 3, minutes: 36 } } };
  app.local.setItem(LEGACY_STATE_KEY, JSON.stringify(legacy));

  const migrated = app.open();
  assert.equal(migrated.state.phase, 'idle', 'a countdown from a previous visit is not a countdown now');
  assert.deepEqual(migrated.state.stats, legacy.stats);
  assert.equal(app.local.getItem(LEGACY_STATE_KEY), null, 'the old blob is gone for good');
  assert.deepEqual(JSON.parse(app.local.getItem(STATS_KEY)), legacy.stats);
});

test('a page that has fallen behind cannot undo a walk logged in another one', () => {
  const app = browser();
  app.open();
  saveStats(WALKS);
  // The heartbeat writes the schedule and only the schedule, however old the copy
  // of the walk log the page is carrying around happens to be.
  saveSchedule({ ...running(), stats: { '2026-08-21': { walks: 0, minutes: 0 } } });
  assert.deepEqual(JSON.parse(app.local.getItem(STATS_KEY)), WALKS);
});

test('settings are untouched by any of this', () => {
  const app = browser();
  app.open();
  saveSettings({ ...DEFAULT_SETTINGS, intervalMinutes: 45 });
  saveSchedule(running());
  app.open();

  assert.equal(loadSettings().intervalMinutes, 45);
  assert.ok(app.local.getItem(SETTINGS_KEY), 'settings outlive every page');
});

test('storage being unavailable is survivable', () => {
  // Private modes and locked-down profiles throw on the accessor itself.
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
  }

  assert.doesNotThrow(() => saveSchedule(running()));
  assert.deepEqual(loadState(), { ...INITIAL_STATE, stats: {} });
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);

  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
});
