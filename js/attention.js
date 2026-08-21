/**
 * In-page attention grabbing: the tab title, the favicon, and the overlay.
 * This is what nags you when the OS notification has already been swiped away.
 */

const ORIGINAL_TITLE = document.title;

/** How the nag reads in the tab: the message, the app name, and back around. */
const MARQUEE_SEPARATOR = ' · ';
const TICK_MS = 200;
const FAVICON_EVERY = 4; // ticks — the icon flips every 800 ms, as it always did
const REDUCED_MOTION_EVERY = 5; // ticks — one character a second instead of five

let stopTicker = null;
let titleMessage = null;
let faviconOn = false;
let originalFavicon = null;
let alarmFaviconUrl = null;

function faviconLink() {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  if (originalFavicon === null) originalFavicon = link.getAttribute('href') ?? '';
  return link;
}

/** A red dot with an exclamation mark, drawn once and reused. */
function alarmFavicon() {
  if (alarmFaviconUrl) return alarmFaviconUrl;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = '#e4381f';
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 46px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('!', 32, 34);
  alarmFaviconUrl = canvas.toDataURL('image/png');
  return alarmFaviconUrl;
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/**
 * The beat for the whole nag. The page's own timers are throttled the moment the
 * tab goes to the background, so the ticks come from a worker instead; a page
 * repainting on a message is not throttled the way a page waiting on
 * `setInterval` is. Returns the function that stops it.
 */
function startTicker(onTick) {
  // The page's own timer: throttled in a hidden tab, but better than a title that
  // has stopped moving altogether.
  let fallbackId = null;
  let stopped = false;
  const useOwnTimer = () => {
    if (stopped || fallbackId !== null) return;
    fallbackId = setInterval(onTick, TICK_MS);
  };

  let worker = null;
  try {
    worker = new Worker(new URL('./marquee-worker.js', import.meta.url));
    worker.addEventListener('message', onTick);
    // A worker that cannot be fetched fails asynchronously, long after the
    // constructor returned happily, so the error event is the only thing standing
    // between a missing file and a title that scrolls one frame and stops.
    worker.addEventListener('error', useOwnTimer);
    worker.postMessage({ everyMs: TICK_MS });
  } catch {
    // Workers are unavailable outright: opened from file://, or blocked by policy.
    useOwnTimer();
  }

  return () => {
    stopped = true;
    worker?.terminate();
    if (fallbackId !== null) clearInterval(fallbackId);
  };
}

/**
 * Put the tab itself to work: the title scrolls the nag and the app name past,
 * one character at a time, and the favicon turns into a red alert dot, until
 * `stopTitleAlarm()`. A tab that is moving is visible out of the corner of an eye
 * in a way a tab that merely renamed itself is not.
 */
export function startTitleAlarm(message) {
  if (stopTicker && titleMessage === message) return; // already running for this message
  stopTitleAlarm();
  titleMessage = message;

  // Split by code point, not by index, or rotating past the emoji cuts it in half
  // and leaves a stray surrogate in the title.
  const characters = Array.from(`${message}${MARQUEE_SEPARATOR}${ORIGINAL_TITLE}${MARQUEE_SEPARATOR}`);
  // Asking the system for less motion slows the scroll rather than stopping it —
  // a title that has stopped moving is the thing this is here to fix.
  const scrollEvery = prefersReducedMotion() ? REDUCED_MOTION_EVERY : 1;
  const link = faviconLink();
  let tick = 0;
  let offset = 0;

  const step = () => {
    if (tick % scrollEvery === 0) {
      document.title = characters.slice(offset).concat(characters.slice(0, offset)).join('');
      offset = (offset + 1) % characters.length;
    }
    if (tick % FAVICON_EVERY === 0) {
      faviconOn = !faviconOn;
      link.href = faviconOn ? alarmFavicon() : originalFavicon;
    }
    tick += 1;
  };

  step();
  stopTicker = startTicker(step);
}

export function stopTitleAlarm() {
  stopTicker?.();
  stopTicker = null;
  titleMessage = null;
  faviconOn = false;
  document.title = ORIGINAL_TITLE;
  if (originalFavicon !== null) faviconLink().href = originalFavicon;
}

/** A quiet title change for levels that do not move the tab. */
export function setTitleSuffix(suffix) {
  if (stopTicker) return; // a running alarm owns the title
  document.title = suffix ? `${suffix} — ${ORIGINAL_TITLE}` : ORIGINAL_TITLE;
}

const overlay = () => document.getElementById('overlay');

let countdownTimer = null;

/**
 * Show the full-screen nag. In `blocking` mode the snooze button is disabled for
 * a few seconds first, so dismissing takes a deliberate act rather than a reflex.
 */
export function showOverlay({ mode, headline, sub, lockSeconds = 0 }) {
  const el = overlay();
  if (!el || mode === 'none') return;

  el.querySelector('#overlay-headline').textContent = headline;
  el.querySelector('#overlay-sub').textContent = sub;
  el.classList.toggle('overlay--blocking', mode === 'blocking');
  el.hidden = false;
  el.dataset.mode = mode;
  document.body.classList.add('is-overlaid');

  const dismiss = el.querySelector('#overlay-snooze');
  const dismissLabel = dismiss.dataset.label ?? dismiss.textContent;
  dismiss.dataset.label = dismissLabel;

  clearInterval(countdownTimer);
  if (lockSeconds > 0) {
    let remaining = lockSeconds;
    dismiss.disabled = true;
    dismiss.textContent = `${dismissLabel} (${remaining})`;
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        dismiss.disabled = false;
        dismiss.textContent = dismissLabel;
      } else {
        dismiss.textContent = `${dismissLabel} (${remaining})`;
      }
    }, 1000);
  } else {
    dismiss.disabled = false;
    dismiss.textContent = dismissLabel;
  }

  // Put the keyboard where the decision is, so a stray Enter means "walk",
  // never "snooze".
  el.querySelector('#overlay-walking')?.focus();
}

export function hideOverlay() {
  const el = overlay();
  if (!el) return;
  clearInterval(countdownTimer);
  el.hidden = true;
  document.body.classList.remove('is-overlaid');
}

export function isOverlayVisible() {
  return Boolean(overlay()) && !overlay().hidden;
}
