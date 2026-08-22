/**
 * Wiring: the tick loop, the state machine, and the UI bindings.
 *
 * The loop is deliberately timestamp-driven rather than countdown-driven. A hidden
 * tab has its timers clamped to roughly once a minute, so anything that counted
 * down by subtracting 1000 ms per tick would drift badly. Comparing `Date.now()`
 * against a stored `nextDueAt` means throttling costs lateness, never a miss.
 */

import {
  MINUTE,
  nextDueFrom,
  effectiveDueAt,
  escalationStep,
  volumeForStep,
  planSnooze,
  planPause,
  planResume,
  addWalk,
  dayKey,
  statsForDay,
  recentDays,
  walkedDays,
  STATS_RETENTION_DAYS,
  formatDuration,
  formatApprox,
  isMissed,
  applyQuietHours,
} from './scheduler.js';

import {
  INITIAL_STATE,
  SCHEDULE_KEY,
  SETTINGS_KEY,
  STATS_KEY,
  loadSettings,
  saveSettings,
  loadStats,
  saveStats,
  loadState,
  readSchedule,
  saveSchedule,
  normalizeSettings,
  profileFor,
} from './settings.js';

import * as alarm from './alarm.js';
import * as notify from './notify.js';
import * as attention from './attention.js';

const TICK_MS = 1000;

/**
 * How often a page re-stamps the stored schedule. The stamp is what marks the
 * countdown as one somebody is running — it is what another page opening looks for
 * — so it has to keep beating even through an hour of waiting with nothing else
 * to write.
 */
const HEARTBEAT_MS = 15_000;

let settings = loadSettings();

// Opening the app joins the countdown any other open page is already running; only
// when there is none does this page get a fresh, idle one of its own.
let state = loadState();

const el = (id) => document.getElementById(id);

const ui = {};

function cacheElements() {
  [
    'status-label', 'countdown', 'status-note', 'progress-bar',
    'btn-start', 'btn-walking', 'btn-snooze', 'btn-pause', 'btn-reset',
    'permission-note', 'walk-banner', 'walk-remaining',
    'today-walks', 'today-minutes', 'day-strip',
    'history-table', 'history-body', 'history-empty', 'history-retention',
    'history-total-walks', 'history-total-minutes',
    'settings-form', 'annoyance-blurb', 'quiet-fields',
    'volume-readout', 'btn-test-sound', 'sound-test-hint',
    'overlay', 'overlay-walking', 'overlay-snooze', 'toast',
  ].forEach((id) => {
    ui[id] = el(id);
  });
  soundTestIdleHint = ui['sound-test-hint'].textContent;
}

/* ------------------------------------------------------------------ helpers */

function persist() {
  // Never the same stamp twice: two writes inside one tick still have to come out in
  // order, since the stamp is how another page tells which schedule is the newer one.
  const now = Math.max(Date.now(), (state.heartbeatAt ?? 0) + 1);
  state.heartbeatAt = now;
  saveSchedule(state, now);
}

/* ------------------------------------------------- keeping the pages in step */

/**
 * Take on a schedule another page wrote. Every open page runs the same countdown,
 * so the last write wins and the others follow it rather than each keeping — and
 * re-saving — a copy of their own.
 */
function adoptSchedule(shared) {
  const wasDue = state.phase === 'due';
  state = { ...shared, stats: state.stats };
  if (wasDue && state.phase !== 'due') {
    // Someone acknowledged, snoozed or reset it in another page; stop nagging here too.
    stopNagging();
    notify.clearNudges();
  }
  applyKeepAlive();
  render();
}

/** Follow the shared schedule when another page has written a newer one. */
function syncSchedule() {
  const shared = readSchedule();
  // Ours is the newest write when it was this page that made it — nothing to adopt.
  if (!shared || (shared.heartbeatAt ?? 0) <= (state.heartbeatAt ?? 0)) return false;
  adoptSchedule(shared);
  return true;
}

/**
 * Sounding something — the alarm for an escalation step, the cue at the end of a
 * walk — is a claim staked on the shared schedule: mark it there first, then sound
 * it. A page that finds another has already made the mark follows that schedule and
 * keeps quiet, so what is heard is one nudge and not one per page that is open.
 */
function claim(alreadyMade, mark) {
  const shared = readSchedule();
  // The mark itself is the evidence: this page has not made it, so a stored schedule
  // carrying it is another page's, and a newer one than this page is holding.
  if (shared && alreadyMade(shared)) {
    adoptSchedule(shared);
    return false;
  }
  mark();
  persist();
  return true;
}

/**
 * The periodic re-stamp. It reads before it writes, so a page whose copy has fallen
 * behind — one that missed a storage event while it was frozen, say — follows the
 * schedule instead of stamping its own stale one over it.
 */
function restamp() {
  if (!syncSchedule()) persist();
}

/** The walk log is shared too — a walk logged in one page counts in all of them. */
function syncStats() {
  state.stats = loadStats();
}

function syncSettings() {
  settings = loadSettings();
  fillSettingsForm();
  applyKeepAlive();
}

function profile() {
  return profileFor(settings);
}

let toastTimer = null;
function toast(message) {
  if (!ui.toast) return;
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 4000);
}

/* ------------------------------------------------------- state transitions */

async function start() {
  // This runs from a click, which is the only moment we are allowed to unlock
  // audio or ask for notification permission.
  await alarm.unlock();
  const result = await notify.requestPermission();
  renderPermissionNote(result);
  applyKeepAlive();

  state = {
    ...state,
    phase: 'waiting',
    nextDueAt: nextDueFrom(Date.now(), settings),
    dueSince: null,
    walkEndsAt: null,
    pausedRemainingMs: null,
    pausedWalkRemainingMs: null,
    snoozesUsed: 0,
    lastAlarmStep: -1,
  };
  persist();
  render();
}

function becomeDue(now) {
  const missed = isMissed(state.nextDueAt, now, settings);
  state.phase = 'due';
  state.dueSince = effectiveDueAt(state.nextDueAt, now, settings);
  state.lastAlarmStep = -1;
  state.snoozesUsed = 0;
  if (missed) toast('Welcome back — that nudge was overdue, so the clock restarted.');
  persist();
}

/** The acknowledgement: "yes, I am getting up". */
function acknowledgeWalk() {
  const now = Date.now();
  const walkEndsAt = now + settings.walkMinutes * MINUTE;
  // Counted onto the log as it stands in storage, not onto this page's copy of it,
  // so a walk logged in another page a moment ago cannot be overwritten here.
  state.stats = addWalk(loadStats(), now, settings.walkMinutes);
  state.phase = 'waiting';
  // One full interval, as agreed — except when the walk is configured longer than
  // the interval itself, where the nudge would otherwise go off mid-walk.
  state.nextDueAt = Math.max(nextDueFrom(now, settings), walkEndsAt);
  state.dueSince = null;
  state.walkEndsAt = settings.sitNudgeEnabled ? walkEndsAt : null;
  state.snoozesUsed = 0;
  state.lastAlarmStep = -1;
  persist();
  saveStats(state.stats);

  stopNagging();
  notify.clearNudges();
  render();
}

function snooze() {
  const plan = planSnooze(Date.now(), settings, profile(), state.snoozesUsed);
  if (!plan.allowed) {
    toast('No snoozes left this round. Get up.');
    return;
  }
  state.phase = 'waiting';
  state.nextDueAt = plan.until;
  state.dueSince = null;
  state.snoozesUsed = plan.snoozesUsed;
  state.lastAlarmStep = -1;
  persist();

  stopNagging();
  notify.clearNudges();
  toast(`Snoozed for ${plan.minutes} min.`);
  render();
}

/**
 * Pause banks the time left on the clock; Resume puts it back. A pause is a
 * break in the sitting, not a fresh cycle — 12 min left before the pause is
 * still 12 min left after it.
 */
function togglePause() {
  const now = Date.now();
  if (state.phase === 'paused') {
    const resumed = planResume(state, now, settings);
    state.phase = 'waiting';
    state.nextDueAt = resumed.nextDueAt;
    state.walkEndsAt = settings.sitNudgeEnabled ? resumed.walkEndsAt : null;
    state.pausedRemainingMs = null;
    state.pausedWalkRemainingMs = null;
    state.dueSince = null;
    state.lastAlarmStep = -1;
  } else {
    const held = planPause(state, now);
    state.phase = 'paused';
    state.pausedRemainingMs = held.pausedRemainingMs;
    state.pausedWalkRemainingMs = held.pausedWalkRemainingMs;
    state.nextDueAt = null;
    state.dueSince = null;
    state.walkEndsAt = null;
    stopNagging();
    notify.clearNudges();
  }
  persist();
  render();
}

function resetSchedule() {
  stopNagging();
  notify.clearNudges();
  state = { ...INITIAL_STATE, stats: state.stats };
  persist();
  render();
}

/* ------------------------------------------------------------- the nagging */

function stopNagging() {
  attention.stopTitleAlarm();
  attention.hideOverlay();
  attention.setTitleSuffix('');
}

function fireAlarm(step) {
  const level = settings.annoyance;
  alarm.play(level, volumeForStep(settings.volume, step, profile()));

  notify.showNudge({
    title: step === 0 ? 'Time to walk' : `Still sitting (${step + 1})`,
    body:
      step === 0
        ? `Get on the walking pad for ${settings.walkMinutes} min. Next nudge ${formatApprox(settings.intervalMinutes * MINUTE)} after you start.`
        : `You have been sitting since this nudge started. ${settings.walkMinutes} min on the pad, that is all.`,
    requireInteraction: profile().requireInteraction,
    renotify: profile().renotify,
  });
}

function nagVisuals() {
  const current = profile();
  if (current.animateTitle) {
    attention.startTitleAlarm('🚶 GET UP');
  } else {
    attention.setTitleSuffix('Time to walk');
  }
  if (document.visibilityState === 'visible' && !attention.isOverlayVisible()) {
    attention.showOverlay({
      mode: current.overlay,
      headline: 'Time to walk',
      sub: `${settings.walkMinutes} minutes on the pad. The clock restarts when you start.`,
      lockSeconds: current.overlay === 'blocking' ? 5 : 0,
    });
  }
}

/* ------------------------------------------------------- testing the volume */

// The "nothing to report yet" wording lives in the HTML; it is captured rather than
// repeated here so the two cannot drift apart.
let soundTestIdleHint = '';
let soundTestTimer = null;

function setSoundTestHint(message) {
  ui['sound-test-hint'].textContent = message;
}

function volumePercent() {
  return `${Math.round(settings.volume * 100)}%`;
}

function restoreTestButton() {
  ui['btn-test-sound'].disabled = false;
  ui['btn-test-sound'].textContent = 'Test sound';
}

/**
 * Play the current chime on demand, so the volume can be judged against the
 * speakers instead of being discovered an hour later. The click is itself the
 * gesture that unlocks audio, which is why this works before Start is pressed.
 */
async function testSound() {
  clearTimeout(soundTestTimer);
  restoreTestButton();

  if (settings.volume <= 0) {
    setSoundTestHint('Volume is at zero — drag the slider up, then test again.');
    return;
  }

  const unlocked = await alarm.unlock();
  if (!unlocked || !alarm.play(settings.annoyance, settings.volume)) {
    setSoundTestHint('This browser is blocking audio in the tab. Click anywhere on the page, then test again.');
    return;
  }

  const current = profile();
  setSoundTestHint(
    current.volumeRamp
      ? `Playing the ${current.label} chime at ${volumePercent()} — this is the first one; each repeat is louder.`
      : `Playing the ${current.label} chime at ${volumePercent()}.`,
  );

  // Disabled for the length of the chime so repeated clicks cannot stack copies
  // of it on top of each other.
  ui['btn-test-sound'].disabled = true;
  ui['btn-test-sound'].textContent = 'Playing…';
  soundTestTimer = setTimeout(restoreTestButton, alarm.patternDurationMs(settings.annoyance));
}

/* -------------------------------------------------------------- tick + render */

function tick() {
  const now = Date.now();

  if (state.walkEndsAt && now >= state.walkEndsAt) {
    const cue = claim(
      (shared) => shared.walkEndsAt === null,
      () => {
        state.walkEndsAt = null;
      },
    );
    if (cue && settings.sitNudgeEnabled) {
      alarm.playSitCue(settings.volume);
      notify.showNudge({
        title: 'You can sit down now',
        body: `That is ${settings.walkMinutes} min done. Next nudge at ${clockTime(state.nextDueAt)}.`,
        tag: 'get-moving-sit',
        actions: false,
      });
    }
  }

  if (state.phase === 'waiting' && state.nextDueAt !== null && now >= state.nextDueAt) {
    becomeDue(now);
  }

  if (state.phase === 'due') {
    const step = escalationStep(state.dueSince, now, profile());
    const mine =
      step > state.lastAlarmStep &&
      claim(
        (shared) => shared.lastAlarmStep >= step,
        () => {
          state.lastAlarmStep = step;
        },
      );
    if (mine) fireAlarm(step);
    nagVisuals();
  }

  // Keep the stored schedule stamped as live; without this an hour of quiet
  // waiting would look, to the next page load, exactly like a closed page.
  if (state.phase !== 'idle' && now - (state.heartbeatAt ?? 0) >= HEARTBEAT_MS) restamp();

  applyKeepAlive();
  render();
}

function clockTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function render() {
  const now = Date.now();
  const isDue = state.phase === 'due';

  document.body.dataset.phase = state.phase;

  const labels = {
    idle: 'Not running',
    waiting: 'Next nudge in',
    due: 'Get up — now',
    paused: 'Paused',
  };
  ui['status-label'].textContent = labels[state.phase];

  if (state.phase === 'waiting' && state.nextDueAt) {
    ui.countdown.textContent = formatDuration(state.nextDueAt - now);
    ui['status-note'].textContent = `Due at ${clockTime(state.nextDueAt)} · every ${settings.intervalMinutes} min`;
  } else if (isDue) {
    ui.countdown.textContent = `+${formatDuration(now - state.dueSince)}`;
    ui['status-note'].textContent = 'Sitting time since the nudge. It is not going to stop on its own.';
  } else if (state.phase === 'paused') {
    const held = state.pausedRemainingMs;
    ui.countdown.textContent = held === null ? '—' : formatDuration(held);
    ui['status-note'].textContent =
      held === null
        ? 'Nothing scheduled. Resume when you are back.'
        : 'Held here. Resume picks the countdown up where it stopped.';
  } else {
    ui.countdown.textContent = '—';
    ui['status-note'].textContent = 'Press start, then leave this tab open in the background.';
  }

  // Progress across the current interval, so a glance tells you where you are.
  let progress = 0;
  const span = settings.intervalMinutes * MINUTE;
  if (state.phase === 'waiting' && state.nextDueAt) {
    progress = 1 - Math.min(1, Math.max(0, (state.nextDueAt - now) / span));
  } else if (isDue) {
    progress = 1;
  } else if (state.phase === 'paused' && state.pausedRemainingMs !== null) {
    // Frozen where the pause caught it, so the bar matches the held countdown.
    progress = 1 - Math.min(1, Math.max(0, state.pausedRemainingMs / span));
  }
  ui['progress-bar'].style.width = `${(progress * 100).toFixed(1)}%`;

  ui['btn-start'].hidden = state.phase !== 'idle';
  ui['btn-walking'].hidden = state.phase === 'idle' || state.phase === 'paused';
  ui['btn-snooze'].hidden = !isDue;
  ui['btn-pause'].hidden = state.phase === 'idle';
  ui['btn-pause'].textContent = state.phase === 'paused' ? 'Resume' : 'Pause';
  ui['btn-reset'].hidden = state.phase === 'idle';
  ui['btn-walking'].textContent = isDue ? "I'm walking 🚶" : 'Walk now (restart the clock)';

  // A walk in progress keeps its banner across a pause, showing the held remainder.
  const walkLeft = state.walkEndsAt
    ? state.walkEndsAt - now
    : (state.phase === 'paused' ? state.pausedWalkRemainingMs : null);
  if (walkLeft !== null) {
    ui['walk-banner'].hidden = false;
    ui['walk-remaining'].textContent = formatDuration(walkLeft);
  } else {
    ui['walk-banner'].hidden = true;
  }

  const today = statsForDay(state.stats, now);
  ui['today-walks'].textContent = String(today.walks);
  ui['today-minutes'].textContent = String(today.minutes);
  renderStrip(now);
  renderHistory(now);
}

function renderStrip(now) {
  const days = recentDays(state.stats, now, 7);
  const peak = Math.max(30, ...days.map((day) => day.minutes));
  ui['day-strip'].innerHTML = '';
  for (const day of days) {
    const column = document.createElement('div');
    column.className = 'strip__col';
    column.title = `${day.key}: ${day.minutes} min over ${day.walks} walk(s)`;
    const bar = document.createElement('div');
    bar.className = 'strip__bar';
    bar.style.height = `${Math.max(3, (day.minutes / peak) * 100)}%`;
    const label = document.createElement('span');
    label.className = 'strip__label';
    label.textContent = new Date(`${day.key}T00:00`).toLocaleDateString([], { weekday: 'narrow' });
    column.append(bar, label);
    ui['day-strip'].append(column);
  }
}

/**
 * The history table: one row per day that has a walk on it, newest first. Days
 * off are absent rather than zeroed, so the table is empty until the first walk.
 */
function renderHistory(now) {
  const days = walkedDays(state.stats, now);
  const todayKey = dayKey(now);

  ui['history-table'].hidden = days.length === 0;
  ui['history-empty'].hidden = days.length > 0;

  const body = ui['history-body'];
  body.innerHTML = '';
  let walks = 0;
  let minutes = 0;

  for (const day of days) {
    walks += day.walks;
    minutes += day.minutes;

    const row = document.createElement('tr');
    const label = document.createElement('th');
    label.scope = 'row';
    label.textContent = day.key === todayKey ? 'Today' : formatDayLabel(day.key);
    // The raw date stays reachable for "Today", and for a weekday that could be
    // any of the last two weeks.
    label.title = day.key;

    const walkCell = document.createElement('td');
    walkCell.textContent = String(day.walks);
    const minuteCell = document.createElement('td');
    minuteCell.textContent = String(day.minutes);

    row.append(label, walkCell, minuteCell);
    body.append(row);
  }

  ui['history-total-walks'].textContent = String(walks);
  ui['history-total-minutes'].textContent = String(minutes);
}

/** "Fri 21 Aug" — short enough for a narrow phone column. */
function formatDayLabel(key) {
  const date = new Date(`${key}T00:00`);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

function renderPermissionNote(result = notify.permission()) {
  const notes = {
    granted: '',
    denied: 'Notifications are blocked for this site, so nudges will only appear in the tab itself. Re-enable them in the padlock menu in the address bar.',
    default: 'Notifications are not enabled yet — press start to allow them.',
    unsupported: 'This browser has no Notification API, so nudges stay inside the tab.',
  };
  const message = notes[result] ?? '';
  ui['permission-note'].textContent = message;
  ui['permission-note'].hidden = !message;
}

/* --------------------------------------------------------------- settings UI */

function fillSettingsForm() {
  const form = ui['settings-form'];
  form.intervalMinutes.value = settings.intervalMinutes;
  form.walkMinutes.value = settings.walkMinutes;
  form.annoyance.value = settings.annoyance;
  form.volume.value = settings.volume;
  form.snoozeMinutes.value = settings.snoozeMinutes;
  form.quietHoursEnabled.checked = settings.quietHoursEnabled;
  form.quietFrom.value = settings.quietFrom;
  form.quietTo.value = settings.quietTo;
  form.sitNudgeEnabled.checked = settings.sitNudgeEnabled;
  form.preciseTimers.checked = settings.preciseTimers;
  ui['annoyance-blurb'].textContent = profile().blurb;
  ui['quiet-fields'].hidden = !settings.quietHoursEnabled;
  ui['volume-readout'].textContent = volumePercent();
}

function readSettingsForm() {
  const form = ui['settings-form'];
  return normalizeSettings({
    intervalMinutes: Number(form.intervalMinutes.value),
    walkMinutes: Number(form.walkMinutes.value),
    annoyance: form.annoyance.value,
    volume: Number(form.volume.value),
    snoozeMinutes: Number(form.snoozeMinutes.value),
    quietHoursEnabled: form.quietHoursEnabled.checked,
    quietFrom: form.quietFrom.value,
    quietTo: form.quietTo.value,
    sitNudgeEnabled: form.sitNudgeEnabled.checked,
    preciseTimers: form.preciseTimers.checked,
  });
}

function onSettingsChanged() {
  const previous = settings;
  settings = readSettingsForm();
  saveSettings(settings);
  fillSettingsForm();
  applyKeepAlive();

  // Whatever the last test reported is stale as soon as either input to it moves.
  if (settings.volume !== previous.volume || settings.annoyance !== previous.annoyance) {
    setSoundTestHint(soundTestIdleHint);
  }

  // A nudge already on screen must adopt the new annoyance level rather than
  // keeping the overlay mode it was opened with.
  if (state.phase === 'due' && settings.annoyance !== previous.annoyance) {
    attention.stopTitleAlarm();
    attention.hideOverlay();
    nagVisuals();
  }

  // Re-anchor a pending nudge so an interval change takes effect immediately
  // rather than after the current cycle finishes.
  if (state.phase === 'waiting' && state.nextDueAt && settings.intervalMinutes !== previous.intervalMinutes) {
    const elapsed = previous.intervalMinutes * MINUTE - (state.nextDueAt - Date.now());
    const reanchored = Date.now() + settings.intervalMinutes * MINUTE - Math.max(0, elapsed);
    state.nextDueAt = applyQuietHours(Math.max(Date.now(), reanchored), settings);
    persist();
  }

  // Same for a held countdown: shortening the interval must not leave a pause
  // banking more time than the interval now allows.
  if (state.phase === 'paused' && state.pausedRemainingMs !== null && settings.intervalMinutes !== previous.intervalMinutes) {
    state.pausedRemainingMs = Math.min(state.pausedRemainingMs, settings.intervalMinutes * MINUTE);
    persist();
  }
  render();
}

function applyKeepAlive() {
  // A nudge on screen keeps the tab audible whichever way the setting is set: a
  // silent background tab gets its timers clamped and can be frozen outright,
  // and a nag whose title has stopped moving is no nag at all. It goes quiet
  // again the moment the nudge is acknowledged.
  const wanted = state.phase === 'due' || (settings.preciseTimers && state.phase !== 'idle');
  if (wanted) {
    alarm.startKeepAlive();
  } else {
    alarm.stopKeepAlive();
  }
}

/* ------------------------------------------------------------------- startup */

function bindEvents() {
  ui['btn-start'].addEventListener('click', start);
  ui['btn-walking'].addEventListener('click', acknowledgeWalk);
  ui['btn-snooze'].addEventListener('click', snooze);
  ui['btn-pause'].addEventListener('click', togglePause);
  ui['btn-reset'].addEventListener('click', resetSchedule);
  ui['btn-test-sound'].addEventListener('click', testSound);
  ui['overlay-walking'].addEventListener('click', acknowledgeWalk);
  ui['overlay-snooze'].addEventListener('click', snooze);

  ui['settings-form'].addEventListener('change', onSettingsChanged);
  ui['settings-form'].addEventListener('input', (event) => {
    if (event.target.name === 'volume') onSettingsChanged();
  });

  // Every other open page writes the schedule it is running to the same place, so
  // a change there is a change here — this is what keeps two open pages on one clock.
  window.addEventListener('storage', ({ key }) => {
    // `null` is a wholesale clear. Anything else of ours — a page announcing itself
    // in the register, say — changes nothing here.
    if (key !== null && key !== SCHEDULE_KEY && key !== STATS_KEY && key !== SETTINGS_KEY) return;
    if (key === null || key === STATS_KEY) syncStats();
    if (key === null || key === SETTINGS_KEY) syncSettings();
    if (key === null || key === SCHEDULE_KEY) syncSchedule();
    render();
  });

  window.addEventListener('pageshow', (event) => {
    // Back out of the bfcache, where this page was frozen: whatever it remembers of
    // the schedule may be minutes old, and its own heartbeat has stopped meanwhile.
    if (!event.persisted) return;
    syncStats();
    syncSchedule();
    tick();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Coming back to a throttled tab: catch up immediately instead of waiting
      // for the next scheduled tick. A frozen tab can have missed storage events
      // while it was away, so the shared schedule is re-read rather than assumed.
      syncStats();
      syncSchedule();
      tick();
      // Re-unlocking is free when already running, and recovers a context that
      // the browser suspended while the tab was hidden.
      if (state.phase !== 'idle') alarm.unlock().then(applyKeepAlive);
    }
  });

  notify.onAction((action) => {
    if (action === 'walking') acknowledgeWalk();
    else if (action === 'snooze') snooze();
    else render();
  });

  // Any click counts as the gesture that revives a suspended audio context.
  document.addEventListener(
    'pointerdown',
    () => {
      if (state.phase !== 'idle') alarm.unlock();
    },
    { passive: true },
  );
}

function init() {
  cacheElements();
  bindEvents();
  fillSettingsForm();
  ui['history-retention'].textContent = String(STATS_RETENTION_DAYS);
  renderPermissionNote();
  notify.initServiceWorker();

  render();
  // Opening into an unacknowledged nudge — a reload, or a second page opened while
  // the first is nagging — puts the takeover back up on this first tick. The nudge
  // is taken as it stands, escalation and all: a page opening is not worth a chime
  // of its own, and the next step will sound in whichever page gets to it first.
  tick();
  setInterval(tick, TICK_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Exposed purely so the Playwright checks can drive the clock without waiting an hour.
window.__getMoving = {
  get state() {
    return state;
  },
  get settings() {
    return settings;
  },
  tick,
  acknowledgeWalk,
  snooze,
  testSound,
};
