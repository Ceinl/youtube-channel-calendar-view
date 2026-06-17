# YouTube Channel Calendar View

A Chrome (Manifest V3) extension that adds a **Calendar** chip next to the
**New / Popular / Oldest** filter chips on any YouTube channel's **Videos** tab.

Clicking it opens a month calendar where **each day shows the thumbnail of the
video(s) released that day**. Days with more than one upload show a thumbnail
collage with a count badge, and clicking any day lists every video from that day.

## Features

- **Native-looking chip** injected into the channel Videos filter bar.
- **Month grid** with a thumbnail on every release day; navigate with the
  `‹ ›` arrows, the month dropdown, `←/→` keys, or the **⤓ Latest** button.
- **Multiple videos on one day** → up to a 4-tile collage + a red count badge;
  click the day to see the full list (thumbnail, title, views, duration, link).
- **Exact dates, loaded automatically:** the current/latest month is shown
  instantly from the relative labels, then every video's *real* publish date is
  fetched from its watch page **in the background** (visible month first), so
  approximate days snap to the correct day as data arrives. Dates are cached
  permanently in `chrome.storage`, so the work happens only once per video.
  The **◷ Exact dates** button forces/retries the whole pass on demand.
- Dark / light theme aware, `Esc` to close, click-outside to dismiss.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`calendar_view`).
4. Open any channel's **Videos** tab, e.g.
   `https://www.youtube.com/@ThePrimeTimeagen/videos`, and click **Calendar**.

Works in any Chromium browser (Chrome, Edge, Brave, Arc). The same folder loads
in Firefox via `about:debugging` → *Load Temporary Add-on* with no changes.

## How dates are determined

YouTube only renders **relative** upload times in a video grid ("3 days ago",
"2 місяці тому") — the exact date is never in the grid. So the relative label is
used only for the **initial** placement while the calendar loads:

| Relative label        | Initial placement                  |
| --------------------- | ---------------------------------- |
| seconds / min / hours | today (exact day)                  |
| days                  | exact day                          |
| weeks / months / years| approximate (`~`)                  |

Then, in the background, the extension fetches each video's **real** publish
date (`datePublished`) from its watch page — current month first, all other
months after — and the approximate days re-pin to the correct day. The watch
page is streamed and the request aborted as soon as the date is found, so it
doesn't download the whole page. Everything is cached in `chrome.storage`, so a
video is only ever fetched once; later opens are instant and exact.

Relative-date parsing (used for the brief initial view) ships with dictionaries
for English, Ukrainian, Polish, Spanish, German, French, Portuguese and
Italian, and falls back to English. Month/weekday names use the page's locale
via `Intl`.

## Notes & limitations

- The calendar reads videos straight from the page. The current/latest month is
  shown after the **first** batch loads, then it keeps auto-scrolling the
  (hidden, behind the overlay) grid in the background to lazy-load up to **600**
  videos, filling other months in as they arrive. Use **Load more videos** to
  fetch additional batches on large channels.
- Live / scheduled / premiere items without a parseable date are skipped.
- Weeks start on Monday.

## Project layout

```
calendar_view/
├── manifest.json        # MV3 manifest (content script only, no background)
├── src/
│   ├── content.js       # chip injection, scraping, date logic, calendar UI
│   └── calendar.css     # all styles, scoped under .cv-chip / #cv-root
└── README.md
```
