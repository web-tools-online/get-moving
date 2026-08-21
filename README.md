# Get Moving

A deliberately annoying reminder to get off the chair and onto the walking pad.

Set an interval, leave the tab open, and get on with your work. Every hour (or
whatever you pick) the page nags you — an OS notification, an escalating chime, a
tab title that scrolls past, and a full-screen takeover — until you press
**I'm walking**. Pressing it restarts the clock, so walking time counts toward
the interval:

```
09:00  nudge  ->  "I'm walking"  ->  walk ~12 min  ->  sit
10:00  nudge  ->  "I'm walking"  ->  walk ~12 min  ->  sit
11:00  nudge  ...
```

No accounts, no server, no tracking. Everything lives in your browser's
`localStorage`.

## Running it

Open the published page and press **Start**. That single click is what unlocks
sound and asks for notification permission — browsers refuse both without a user
gesture.

**The tab has to stay open.** GitHub Pages is a static host, so there is no server
to push a notification from; the countdown lives in the page itself. Two ways to
make that painless:

- Leave it in a background tab. It is a normal tab and costs nothing.
- Install it as an app (Chrome/Edge: the install icon in the address bar) so it
  gets its own window, out of the way of your browsing.

### Settings

| Setting | What it does |
| --- | --- |
| **Nudge me every** | The interval. The next nudge is always this long after you press "I'm walking". |
| **Walk for** | Only drives the "you can sit down now" cue and the daily tally — never the schedule. |
| **Annoyance** | Gentle, Nagging or Infuriating. See below. |
| **Volume** | Alarm loudness, shown as a percentage. **Test sound** plays the chime for the current annoyance level at that volume, so you can set it against your speakers instead of finding out an hour later. It works before you press Start — the click is the gesture that unlocks audio. The chime is synthesised, so there is nothing to download. |
| **Snooze for** | How far a snooze pushes the nudge out. Infuriating caps this at 5 min, twice per cycle. |
| **Quiet hours** | A window (it may cross midnight) where nudges are deferred to the end instead of firing. |
| **Keep timers precise** | Plays an inaudible tone so the browser stops throttling the tab. See "Accuracy". |

### Annoyance levels

|  | Gentle | Nagging (default) | Infuriating |
| --- | --- | --- | --- |
| Notification | auto-dismisses | stays until clicked | stays, and re-fires each round |
| Chime | once | every 30 s, ten times | every 15 s, getting louder, forever |
| Tab title & icon | quiet title change | scrolling title, red icon | scrolling title, red icon |
| Full-screen takeover | none | dismissible | blocking; snooze unlocks after 5 s |

The scrolling title runs the nag and the app name past the tab, a character at a
time, so a tab you are not looking at still moves in the corner of your eye —
the point being a tab that *keeps moving*, not one that renamed itself once.

That is harder than it sounds in the place it matters. A hidden tab has its
timers clamped to one a second, and to one a minute once it has been hidden for
five, which would leave the title shuffling a character a minute. So the scroll
is driven by a timer inside a worker, which is not clamped, and while a nudge is
unacknowledged the page holds the near-silent keep-alive tone open whatever
**Keep timers precise** is set to — an audible tab is one the browser will not
freeze. The speaker icon appears on the tab for as long as the nudge is up and
goes away when you acknowledge it.

If your system asks for *reduce motion*, the title scrolls a character a second
instead of five — slower, but still moving, since a still title is the thing
this is here to fix.

## Accuracy in a background tab

Browsers clamp timers in hidden tabs to roughly once a minute. The schedule is
stored as a timestamp and compared against the clock on every tick rather than
counted down, so throttling can make a nudge up to about a minute late but can
never make it disappear. If you want it exact, turn on **Keep timers precise** —
it loops a silent tone, which makes the browser treat the tab as playing audio
and stop throttling it. The cost is a speaker icon on the tab.

Closing the laptop is handled too: if a nudge comes due while the machine is
asleep, the page notices on wake, fires once, and restarts the clock instead of
pretending it has been screaming for six hours.

## Publishing it

The site is plain static files at the repository root — no build step, no
dependencies.

1. **Settings → Pages → Build and deployment**
2. Source: **Deploy from a branch**
3. Branch: **`main`**, folder: **`/ (root)`**

It then serves from `https://<owner>.github.io/get-moving/`. Notifications need
HTTPS, which Pages provides; opening `index.html` straight off disk will not work.

## Development

```bash
npm test          # unit tests for the scheduling logic (no dependencies)
npm run serve     # http://localhost:8000
```

The scheduling rules — interval arithmetic, quiet hours, escalation cadence,
snooze rationing, the daily tally — live in `js/scheduler.js` as pure functions
with no DOM or storage access, which is what makes them testable under
`node --test`.

There is also an end-to-end check that drives the real page in Chromium. It needs
Playwright, which is deliberately not a dependency of the site:

```bash
npm install --no-save playwright && npx playwright install chromium
node test/browser-check.mjs        # screenshots land in test/screenshots/
```

### Layout

| Path | Role |
| --- | --- |
| `index.html`, `styles.css` | The page. One stylesheet, no external fonts. |
| `js/scheduler.js` | Pure scheduling logic. Start here. |
| `js/settings.js` | Defaults, annoyance profiles, `localStorage` persistence. |
| `js/app.js` | The tick loop, the state machine, and the UI bindings. |
| `js/alarm.js` | WebAudio chimes and the anti-throttling keep-alive. |
| `js/notify.js` | Notification permission and delivery. |
| `js/attention.js` | The scrolling tab title, favicon swap, the overlay. |
| `js/marquee-worker.js` | The unthrottled timer the scrolling title runs on. |
| `sw.js` | Routes notification clicks back into the page; small offline cache. |

### Worth checking by hand

Some of this cannot be automated, and it is what actually matters day to day:

- [ ] Nudge arrives while the tab is in the background (should be ≤ ~1 min late).
- [ ] Clicking the notification focuses the tab; its **I'm walking** button
      acknowledges without you touching the page.
- [ ] Reload mid-cycle — the countdown carries on where it was.
- [ ] Pause, wait a while, resume — the countdown continues from where it was
      paused rather than starting a fresh interval.
- [ ] Sleep the machine past a nudge, wake it, and confirm the clock restarts.
- [ ] Install as an app and confirm it nags from its own window.
- [ ] Let a nudge fire with the tab in the background, leave it there for more
      than five minutes, and confirm the tab name is still scrolling — not
      inching a character at a time.
- [ ] Turn on *reduce motion* in the OS and confirm the title still moves, just
      more slowly.
