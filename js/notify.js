/**
 * OS notifications. Prefers the service worker registration (required on Android,
 * and the only way to get action buttons) and falls back to a page-owned
 * Notification when there is no worker — e.g. when opened from file://.
 */

const TAG = 'get-moving-nudge';

let registration = null;
let actionHandler = () => {};

export function isSupported() {
  return 'Notification' in window;
}

export function permission() {
  return isSupported() ? Notification.permission : 'unsupported';
}

/** Register the worker. Failure is non-fatal — the page still nags on its own. */
export async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    registration = await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url));
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'notification-action') actionHandler(event.data.action);
    });
    return registration;
  } catch {
    return null;
  }
}

/** Called with 'walking' | 'snooze' | 'open' when a notification is acted on. */
export function onAction(handler) {
  actionHandler = handler;
}

/** Must be called from a user gesture on Safari. Returns the resulting permission. */
export async function requestPermission() {
  if (!isSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export async function showNudge({ title, body, requireInteraction = false, renotify = false, tag = TAG, actions = true }) {
  if (!isSupported() || Notification.permission !== 'granted') return false;

  const options = {
    body,
    tag,
    renotify,
    requireInteraction,
    icon: assetUrl('icon-192.png'),
    badge: assetUrl('icon-192.png'),
    silent: true, // our own WebAudio alarm is the sound; avoid a doubled chime
  };

  if (registration) {
    try {
      await registration.showNotification(title, {
        ...options,
        actions: actions
          ? [
              { action: 'walking', title: "I'm walking" },
              { action: 'snooze', title: 'Snooze' },
            ]
          : [],
      });
      return true;
    } catch {
      /* fall through to the page-owned notification */
    }
  }

  try {
    const notification = new Notification(title, options);
    notification.onclick = () => {
      window.focus();
      notification.close();
      actionHandler('open');
    };
    return true;
  } catch {
    return false;
  }
}

/** Close any nudge still sitting in the tray, e.g. after acknowledging in the page. */
export async function clearNudges() {
  if (!registration?.getNotifications) return;
  try {
    const open = await registration.getNotifications({ tag: TAG });
    open.forEach((notification) => notification.close());
  } catch {
    /* nothing to clear */
  }
}

/** Resolved against this module's URL so it works under a project subpath. */
function assetUrl(name) {
  return new URL(`../${name}`, import.meta.url).href;
}
