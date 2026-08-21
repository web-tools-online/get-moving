/**
 * End-to-end check of the page in a real browser.
 *
 * Not part of `npm test` — it needs Playwright, which this repo deliberately does
 * not depend on (the site itself has no build step and no runtime dependencies):
 *
 *   npm install --no-save playwright && npx playwright install chromium
 *   node test/browser-check.mjs
 *
 * Set CHROME_PATH to use a Chromium you already have.
 * Screenshots land in test/screenshots/.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const shots = join(here, 'screenshots');
const PORT = 8123;
const ORIGIN = `http://localhost:${PORT}`;
const MINUTE = 60_000;

mkdirSync(shots, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: root,
  stdio: 'ignore',
});

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/** Records every notification the page raises, through either code path. */
const NOTIFICATION_SPY = `
  window.__notifications = [];
  const record = (title, options) => window.__notifications.push({ title, ...options });
  if (window.ServiceWorkerRegistration) {
    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      record(title, options);
      return Promise.resolve();
    };
  }
  const Original = window.Notification;
  class SpyNotification {
    constructor(title, options) { record(title, options); }
    close() {}
  }
  SpyNotification.permission = 'granted';
  SpyNotification.requestPermission = () => Promise.resolve('granted');
  window.Notification = SpyNotification;
`;

/** Counts every oscillator the page schedules, which is how "did it play" is checked. */
const AUDIO_SPY = `
  window.__oscillators = 0;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx) {
    const original = Ctx.prototype.createOscillator;
    Ctx.prototype.createOscillator = function (...args) {
      window.__oscillators += 1;
      return original.apply(this, args);
    };
  }
`;

async function main() {
  await waitForServer();

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const context = await browser.newContext();
  await context.grantPermissions(['notifications'], { origin: ORIGIN });
  await context.addInitScript(NOTIFICATION_SPY);
  await context.addInitScript(AUDIO_SPY);

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(ORIGIN, { waitUntil: 'load' });

  /** Drive the clock forward without waiting an hour. */
  const makeDue = () =>
    page.evaluate(() => {
      window.__getMoving.state.nextDueAt = Date.now() - 1000;
      window.__getMoving.tick();
    });

  const state = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__getMoving.state)));
  const notifications = () => page.evaluate(() => window.__notifications);
  const oscillators = () => page.evaluate(() => window.__oscillators);

  /** Range inputs cannot be filled, so nudge the slider the way a drag would. */
  const setVolume = (value) =>
    page.evaluate((v) => {
      const input = document.querySelector('input[name="volume"]');
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);

  check('the page loads in the idle phase', async () => {
    assert.equal(await page.getAttribute('body', 'data-phase'), 'idle');
    await expectVisibleText('#status-label', 'Not running');
    await page.screenshot({ path: join(shots, '01-idle.png'), fullPage: true });
  });

  check('the volume can be tested before the timer is ever started', async () => {
    await expectVisibleText('#volume-readout', '60%');

    await page.evaluate(() => {
      window.__oscillators = 0;
    });
    await page.click('#btn-test-sound');
    await page.waitForFunction(() => window.__oscillators > 0);

    await expectVisibleText('#sound-test-hint', 'Nagging');
    await expectVisibleText('#sound-test-hint', '60%');
    assert.equal((await state()).phase, 'idle', 'testing the sound must not start the schedule');
    assert.deepEqual(await notifications(), [], 'a test is not a nudge');

    // The button locks itself for the length of the chime, then comes back.
    await page.waitForSelector('#btn-test-sound:not([disabled])');
  });

  check('a muted slider says so instead of playing nothing in silence', async () => {
    await setVolume(0);
    await expectVisibleText('#volume-readout', '0%');
    const before = await oscillators();
    await page.click('#btn-test-sound');
    await expectVisibleText('#sound-test-hint', 'Volume is at zero');
    assert.equal(await oscillators(), before, 'nothing was played at zero volume');

    await setVolume(0.6);
    await expectVisibleText('#sound-test-hint', 'Plays the chime', 'the stale result cleared');
    await page.screenshot({ path: join(shots, '01b-volume-test.png'), fullPage: true });
  });

  check('start schedules the first nudge one interval out', async () => {
    await page.click('#btn-start');
    const after = await state();
    assert.equal(after.phase, 'waiting');
    const expected = Date.now() + 60 * MINUTE;
    assert.ok(Math.abs(after.nextDueAt - expected) < 5000, `nextDueAt ${after.nextDueAt} vs ${expected}`);
    await expectVisibleText('#status-label', 'Next nudge in');
    await page.screenshot({ path: join(shots, '02-waiting.png'), fullPage: true });
  });

  check('reaching the due time fires a notification and takes over the tab', async () => {
    await makeDue();
    assert.equal((await state()).phase, 'due');
    assert.equal(await page.getAttribute('body', 'data-phase'), 'due');

    const raised = await notifications();
    assert.equal(raised.length, 1, 'exactly one nudge so far');
    assert.equal(raised[0].title, 'Time to walk');
    assert.equal(raised[0].requireInteraction, true, 'nagging uses a sticky notification');

    await page.waitForSelector('#overlay:not([hidden])');
    await page.waitForFunction(() => document.title.includes('GET UP'));
    await page.screenshot({ path: join(shots, '03-due-overlay.png'), fullPage: true });
  });

  check('the tab name scrolls while the nudge is up', async () => {
    const first = await page.title();
    // Same characters, different starting point: the title is rotating, not rewritten.
    await page.waitForFunction(
      (before) => document.title !== before,
      first,
      { timeout: 5000 },
    );
    // The browser trims the title, so compare the characters without the spaces.
    const letters = (title) => [...title.replace(/\s/g, '')].sort().join('');
    const second = await page.title();
    assert.equal(
      letters(second),
      letters(first),
      `the title moved rather than changing content ("${first}" -> "${second}")`,
    );
    assert.ok(second.includes('Get Moving'), 'the app name travels with the nag');
  });

  check('acknowledging restarts the clock at a full interval', async () => {
    const acknowledgedAt = Date.now();
    await page.click('#overlay-walking');
    const after = await state();
    assert.equal(after.phase, 'waiting');
    assert.ok(Math.abs(after.nextDueAt - (acknowledgedAt + 60 * MINUTE)) < 5000, 'next nudge is one interval after the walk started');
    assert.ok(after.walkEndsAt > Date.now(), 'the sit-down cue is pending');
    assert.equal(await page.isVisible('#overlay'), false, 'the overlay is gone');
    assert.equal(await page.evaluate(() => document.title), 'Get Moving', 'the title stopped moving');
  });

  check('the walk is counted in the daily tally', async () => {
    await expectVisibleText('#today-walks', '1');
    await expectVisibleText('#today-minutes', '12');
    await page.waitForSelector('#walk-banner:not([hidden])');
    await page.screenshot({ path: join(shots, '04-walking.png'), fullPage: true });
  });

  check('a reload mid-cycle keeps the countdown', async () => {
    const before = await state();
    await page.reload({ waitUntil: 'load' });
    const after = await state();
    assert.equal(after.phase, 'waiting');
    assert.equal(after.nextDueAt, before.nextDueAt, 'the schedule survived the reload');
    assert.deepEqual(after.stats, before.stats, 'the stats survived the reload');
  });

  check('pause holds the countdown and resume continues it', async () => {
    // Wind the clock most of the way through the interval, so a restarted
    // countdown is unmistakable next to a continued one.
    await page.evaluate(() => {
      window.__getMoving.state.nextDueAt = Date.now() + 10 * 60_000;
      window.__getMoving.tick();
    });
    const before = await state();
    await page.click('#btn-pause');
    const paused = await state();
    assert.equal(paused.phase, 'paused');
    assert.ok(
      Math.abs(paused.pausedRemainingMs - (before.nextDueAt - Date.now())) < 5000,
      'the time left was banked, not discarded',
    );
    await expectVisibleText('#btn-pause', 'Resume');
    await expectVisibleText('#status-label', 'Paused');
    await page.screenshot({ path: join(shots, '04b-paused.png'), fullPage: true });

    // A reload while paused must not quietly hand back a full interval either.
    await page.reload({ waitUntil: 'load' });
    assert.equal((await state()).pausedRemainingMs, paused.pausedRemainingMs, 'the banked time survived the reload');

    const resumedAt = Date.now();
    await page.click('#btn-pause');
    const after = await state();
    assert.equal(after.phase, 'waiting');
    assert.equal(after.pausedRemainingMs, null);
    assert.ok(
      Math.abs(after.nextDueAt - (resumedAt + paused.pausedRemainingMs)) < 5000,
      `resume continued the countdown rather than restarting it (${after.nextDueAt - resumedAt} ms left)`,
    );
    assert.ok(after.nextDueAt - resumedAt < 11 * MINUTE, 'a fresh 60 min interval would mean the countdown restarted');
    assert.ok(after.walkEndsAt > Date.now(), 'the pending sit-down cue came back too');
  });

  check('snoozing pushes the nudge out by the snooze length only', async () => {
    await makeDue();
    // The overlay covers the card while a nudge is up, so snooze from the overlay.
    await page.waitForSelector('#overlay:not([hidden])');
    const snoozedAt = Date.now();
    await page.click('#overlay-snooze');
    const after = await state();
    assert.equal(after.phase, 'waiting');
    assert.ok(Math.abs(after.nextDueAt - (snoozedAt + 5 * MINUTE)) < 5000, 'snoozed five minutes');
    assert.equal(after.snoozesUsed, 1);
    await expectVisibleText('#today-walks', '1', 'a snooze is not a walk');
  });

  check('changing the interval re-anchors the pending nudge', async () => {
    await page.selectOption('select[name="annoyance"]', 'nagging');
    await page.fill('input[name="intervalMinutes"]', '30');
    await page.dispatchEvent('input[name="intervalMinutes"]', 'change');
    const after = await state();
    assert.equal((await page.evaluate(() => window.__getMoving.settings)).intervalMinutes, 30);
    assert.ok(after.nextDueAt - Date.now() <= 30 * MINUTE + 5000, 'the pending nudge moved in with the shorter interval');
  });

  check('infuriating escalates faster and locks the snooze button', async () => {
    await page.selectOption('select[name="annoyance"]', 'infuriating');
    await page.evaluate(() => {
      window.__notifications.length = 0;
    });
    await makeDue();

    await page.waitForSelector('#overlay.overlay--blocking:not([hidden])');
    assert.equal(await page.isDisabled('#overlay-snooze'), true, 'the snooze button starts locked');
    await page.screenshot({ path: join(shots, '05-infuriating.png'), fullPage: true });

    // Wind the due time back so the escalation cadence has "elapsed".
    await page.evaluate(() => {
      window.__getMoving.state.dueSince = Date.now() - 46_000; // three 15 s steps
      window.__getMoving.tick();
    });
    const raised = await notifications();
    assert.ok(raised.length >= 2, `expected a re-fired nudge, saw ${raised.length}`);
    assert.equal(raised.at(-1).renotify, true, 'infuriating re-notifies rather than replacing silently');
  });

  check('the snooze ration runs out under infuriating', async () => {
    await page.evaluate(() => {
      window.__getMoving.state.snoozesUsed = 2;
    });
    const before = await state();
    await page.evaluate(() => window.__getMoving.snooze());
    const after = await state();
    assert.equal(after.phase, 'due', 'still due — the snooze was refused');
    assert.equal(after.nextDueAt, before.nextDueAt);
    await expectVisibleText('#toast', 'No snoozes left');
  });

  check('quiet hours defer a nudge that would land inside the window', async () => {
    await page.evaluate(() => window.__getMoving.acknowledgeWalk());
    await page.check('input[name="quietHoursEnabled"]');
    await page.fill('input[name="quietFrom"]', '00:00');
    await page.dispatchEvent('input[name="quietFrom"]', 'change');
    await page.fill('input[name="quietTo"]', '23:59');
    await page.dispatchEvent('input[name="quietTo"]', 'change');
    await page.evaluate(() => window.__getMoving.acknowledgeWalk());

    const after = await state();
    const dueAt = new Date(after.nextDueAt);
    assert.equal(`${dueAt.getHours()}:${dueAt.getMinutes()}`, '23:59', 'deferred to the end of the quiet window');
  });

  check('the service worker registered and the manifest is reachable', async () => {
    const registered = await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()));
    assert.equal(registered, true, 'service worker registration failed');
    for (const asset of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon.svg']) {
      const response = await page.request.get(`${ORIGIN}/${asset}`);
      assert.equal(response.status(), 200, `${asset} is missing`);
    }
  });

  async function expectVisibleText(selector, expected, message) {
    await page.waitForSelector(`${selector}:not([hidden])`);
    const text = (await page.textContent(selector))?.trim();
    assert.ok(text?.includes(expected), message ?? `expected ${selector} to contain "${expected}", got "${text}"`);
  }

  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}\n     ${error.message}`);
    }
  }

  if (errors.length) {
    failed += 1;
    console.log(`FAIL no console errors\n     ${errors.join('\n     ')}`);
  } else {
    console.log('ok   no console errors');
  }

  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${checks.length + 1} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(ORIGIN);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('the static server never came up');
}

try {
  await main();
} finally {
  server.kill();
}
