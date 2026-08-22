/**
 * Where state is kept, which is what decides whether a countdown survives.
 *
 * The rule under test: the countdown belongs to the app, not to one page of it —
 * open the app a second time and both pages run the same clock — but it only
 * survives while at least one page is open. Settings and the walk log are the
 * browser's and outlive every page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS_KEY,
  SCHEDULE_KEY,
  PAGES_KEY,
  PAGE_ID_KEY,
  STATS_KEY,
  LEGACY_STATE_KEY,
  STALE_STATE_MS,
  INITIAL_STATE,
  isStaleState,
  hasOpenPage,
  openPage,
  markPageOpen,
  markPageClosed,
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
 * sessionStorage belongs to a page and comes back when that page reloads.
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
    /** Open the app. Hand back a page's session store to reload that page instead. */
    open(session = fakeStorage()) {
      focus(session);
      return { session, ...openPage() };
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

test('the schedule goes to the browser, and the page keeps nothing but its name', () => {
  const app = browser();
  const page = app.open();
  saveSchedule(running());
  saveStats(WALKS);

  const stored = JSON.parse(app.local.getItem(SCHEDULE_KEY));
  assert.equal(stored.phase, 'waiting');
  assert.equal(stored.nextDueAt, DUE_AT);
  assert.equal(stored.stats, undefined, 'the walk log has no business in the schedule blob');
  assert.deepEqual(JSON.parse(app.local.getItem(STATS_KEY)), WALKS);

  assert.equal(page.session.getItem(PAGE_ID_KEY), page.id);
  assert.equal(page.session.size, 1, 'nothing else is tied to the page itself');
});

test('a second page joins the countdown the first one is already running', () => {
  const app = browser();
  const first = app.open();
  saveSchedule(running());

  const second = app.open();
  assert.notEqual(second.id, first.id, 'a new page, not the first one again');
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

  // A reload strikes the page off the register on the way out, exactly as a close
  // does; what tells them apart is that sessionStorage comes back.
  markPageClosed(page.id);
  const reloaded = app.open(page.session);

  assert.equal(reloaded.id, page.id, 'the same page, back again');
  assert.equal(reloaded.state.phase, 'waiting');
  assert.equal(reloaded.state.nextDueAt, DUE_AT);
  assert.deepEqual(reloaded.state.stats, WALKS);
});

test('when the last page closes, the countdown goes with it', () => {
  const app = browser();
  const page = app.open();
  saveSchedule(running());
  saveStats(WALKS);
  markPageClosed(page.id);

  const later = app.open();
  assert.equal(later.state.phase, 'idle');
  assert.equal(later.state.nextDueAt, null);
  assert.equal(app.local.getItem(SCHEDULE_KEY), null, 'the countdown nobody was running is gone for good');
  assert.deepEqual(later.state.stats, WALKS, 'the walks were still walked');
});

test('one page closing does not stop a countdown another page is still holding', () => {
  const app = browser();
  const first = app.open();
  saveSchedule(running());
  const second = app.open();
  app.focus(second.session);
  markPageClosed(first.id);

  const third = app.open();
  assert.equal(third.state.phase, 'waiting', 'the second page still has the app open');
  assert.equal(third.state.nextDueAt, DUE_AT);
});

test('a page that went away without saying so stops counting once it goes quiet', () => {
  const now = Date.now();
  const app = browser();
  app.focus();
  // A page killed outright — no goodbye, just a countdown and a heartbeat that stop.
  saveSchedule(running(), now);
  markPageOpen('a-page-that-was-killed', now - STALE_STATE_MS - 1);

  assert.equal(hasOpenPage('somebody-else', now), false);
  assert.equal(app.open().state.phase, 'idle');
});

test('a schedule nobody has been beating on is not resumed', () => {
  const now = Date.now();
  assert.equal(isStaleState(running({ heartbeatAt: now - 5_000 }), now), false);
  assert.equal(isStaleState(running({ heartbeatAt: now - STALE_STATE_MS - 1 }), now), true);
  assert.equal(isStaleState(running({ heartbeatAt: null }), now), true, 'no stamp, no claim');
  assert.equal(isStaleState({ ...INITIAL_STATE, heartbeatAt: null }, now), false, 'idle is nobody’s countdown');
});

test('a session restore hands back an hour-old countdown, and it is dropped', () => {
  const app = browser();
  const page = app.open();
  saveSchedule(running(), Date.now() - 60 * 60_000);
  markPageClosed(page.id);

  // What a browser hands back when it reopens last time's tabs: the page's own
  // sessionStorage, hours after everything actually stopped.
  const restored = app.open(page.session);
  assert.equal(restored.state.phase, 'idle');
  assert.equal(readSchedule(), null, 'the stale blob was cleared, not left to be re-read');
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
  const page = app.open();
  saveSettings({ ...DEFAULT_SETTINGS, intervalMinutes: 45 });
  saveSchedule(running());
  markPageClosed(page.id);
  app.open();

  assert.equal(loadSettings().intervalMinutes, 45);
  assert.ok(app.local.getItem(SETTINGS_KEY), 'settings outlive every page');
  assert.ok(app.local.getItem(PAGES_KEY), 'and the register says who is open right now');
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
  assert.doesNotThrow(() => markPageClosed('whoever'));
  const opened = openPage();
  assert.ok(opened.id, 'the page still names itself, it just cannot write the name down');
  assert.deepEqual(opened.state, { ...INITIAL_STATE, stats: {} });
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);

  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
});
