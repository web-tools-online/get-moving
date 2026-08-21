/**
 * The metronome behind the moving tab title.
 *
 * It exists for one reason: a hidden tab has its own timers clamped to one a
 * second, and to one a minute once it has been out of sight for five — which is
 * exactly when the title is supposed to be moving. Timers inside a worker keep
 * their cadence, so the beat is kept here and the page only repaints on each
 * message. Terminating the worker is what stops it.
 */

let timer = null;

self.addEventListener('message', (event) => {
  clearInterval(timer);
  timer = setInterval(() => self.postMessage('tick'), event.data.everyMs);
});
