/**
 * In-page attention grabbing: the tab title, the favicon, and the overlay.
 * This is what nags you when the OS notification has already been swiped away.
 */

const ORIGINAL_TITLE = document.title;

/** How the nag reads in the tab: the message, the app name, and back around. */
const MARQUEE_SEPARATOR = ' · ';
const MARQUEE_STEP_MS = 250;
const FAVICON_STEP_MS = 800;

let titleTimer = null;
let titleMessage = null;
let faviconTimer = null;
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
 * Scroll the nag across the tab title, one character per step. Split by code
 * point rather than by index, or rotating past the emoji cuts it in half and
 * leaves a stray surrogate in the title.
 */
function scrollTitle(message) {
  const characters = Array.from(`${message}${MARQUEE_SEPARATOR}${ORIGINAL_TITLE}${MARQUEE_SEPARATOR}`);
  let offset = 0;
  const step = () => {
    document.title = characters.slice(offset).concat(characters.slice(0, offset)).join('');
    offset = (offset + 1) % characters.length;
  };
  step();
  return setInterval(step, MARQUEE_STEP_MS);
}

/** The still version, for anyone who has asked the system for less movement. */
function alternateTitle(message) {
  let on = false;
  const step = () => {
    on = !on;
    document.title = on ? message : ORIGINAL_TITLE;
  };
  step();
  return setInterval(step, FAVICON_STEP_MS);
}

/**
 * Put the tab itself to work: the title starts moving and the favicon turns into
 * a red alert dot, until `stopTitleAlarm()`. A tab that is scrolling is visible
 * out of the corner of an eye in a way a static "(1)" never is.
 */
export function startTitleAlarm(message) {
  if (titleTimer && titleMessage === message) return; // already running for this message
  stopTitleAlarm();
  titleMessage = message;
  titleTimer = prefersReducedMotion() ? alternateTitle(message) : scrollTitle(message);

  const link = faviconLink();
  const flip = () => {
    faviconOn = !faviconOn;
    link.href = faviconOn ? alarmFavicon() : originalFavicon;
  };
  flip();
  faviconTimer = setInterval(flip, FAVICON_STEP_MS);
}

export function stopTitleAlarm() {
  clearInterval(titleTimer);
  clearInterval(faviconTimer);
  titleTimer = null;
  faviconTimer = null;
  titleMessage = null;
  faviconOn = false;
  document.title = ORIGINAL_TITLE;
  if (originalFavicon !== null) faviconLink().href = originalFavicon;
}

/** A quiet title change for levels that do not move the tab. */
export function setTitleSuffix(suffix) {
  if (titleTimer) return; // a running alarm owns the title
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
