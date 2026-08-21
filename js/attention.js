/**
 * In-page attention grabbing: the tab title, the favicon, and the overlay.
 * This is what nags you when the OS notification has already been swiped away.
 */

const ORIGINAL_TITLE = document.title;

let flashTimer = null;
let flashMessage = null;
let flashOn = false;
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

/** Alternate the title (and favicon) until `stopFlash()`. */
export function startFlash(message) {
  if (flashTimer && flashMessage === message) return; // already flashing this
  stopFlash();
  flashMessage = message;
  const link = faviconLink();
  const tick = () => {
    flashOn = !flashOn;
    document.title = flashOn ? message : ORIGINAL_TITLE;
    link.href = flashOn ? alarmFavicon() : originalFavicon;
  };
  tick();
  flashTimer = setInterval(tick, 800);
}

export function stopFlash() {
  if (flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
  flashOn = false;
  flashMessage = null;
  document.title = ORIGINAL_TITLE;
  if (originalFavicon !== null) faviconLink().href = originalFavicon;
}

/** A quiet title change for levels that do not flash. */
export function setTitleSuffix(suffix) {
  if (flashTimer) return; // a flash in progress owns the title
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
