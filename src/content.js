/* =============================================================================
 * Calendar View for YouTube
 * -----------------------------------------------------------------------------
 * Injects a "Calendar" chip next to the New / Popular / Oldest filter chips on a
 * channel's Videos tab. Clicking it opens a month calendar where each day shows
 * the thumbnail of the video(s) released that day. Days with more than one
 * upload show a thumbnail collage + a count badge, and clicking a day lists all
 * of that day's videos.
 *
 * Dates come from the relative "x days ago" labels that YouTube renders, which
 * are day-accurate for recent uploads and approximate for older ones. An
 * optional "Exact dates" pass fetches each video's watch page to read the
 * precise publish date and caches it forever (dates never change).
 * ========================================================================== */

(() => {
  "use strict";

  // Don't run inside embedded players / iframes.
  if (window.top !== window.self) return;

  const LOG = "[CalendarView]";
  const CHIP_ID = "cv-calendar-chip";
  const ROOT_ID = "cv-root";
  const CACHE_KEY = "cv_exact_dates";
  const DEFAULT_CAP = 600; // videos to auto-load before showing a "Load more"
  const CAP_STEP = 400;

  /* ------------------------------------------------------------------ utils */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* --------------------------------------------------------------- locale */
  const pageLang = (
    document.documentElement.lang ||
    navigator.language ||
    "en"
  ).toLowerCase();
  const lang2 = pageLang.slice(0, 2);

  const LABELS = {
    en: "Calendar",
    uk: "Календар",
    pl: "Kalendarz",
    es: "Calendario",
    de: "Kalender",
    fr: "Calendrier",
    pt: "Calendário",
    it: "Calendario",
  };
  const chipLabel = LABELS[lang2] || LABELS.en;

  // Keyword fragments (lowercased) used to map a relative date to a unit.
  // Kept per-language so substrings from one language can't collide with
  // another (e.g. Ukrainian "годин" = hour vs "рік" = year).
  const UNIT_WORDS = {
    en: { y: ["year", "yr"], mo: ["month"], w: ["week", "wk"], d: ["day"], h: ["hour", "hr"], min: ["minute", "min"], s: ["second", "sec"] },
    uk: { y: ["рік", "роки", "років", "рок"], mo: ["місяц", "міс"], w: ["тиждень", "тижн", "тижд"], d: ["день", "дні", "днів", "дня"], h: ["годин"], min: ["хвилин", "хв"], s: ["секунд"] },
    pl: { y: ["rok", "lat", "lata"], mo: ["miesiąc", "miesi", "mies"], w: ["tydzień", "tygod", "tyg"], d: ["dzień", "dzien", "dni"], h: ["godzin"], min: ["minut"], s: ["sekund"] },
    es: { y: ["año", "ano"], mo: ["mes"], w: ["semana"], d: ["día", "dia"], h: ["hora"], min: ["minuto", "min"], s: ["segundo"] },
    de: { y: ["jahr"], mo: ["monat"], w: ["woche"], d: ["tag"], h: ["stunde"], min: ["minute", "min"], s: ["sekunde"] },
    fr: { y: ["an", "ann"], mo: ["mois"], w: ["semaine"], d: ["jour"], h: ["heure"], min: ["minute", "min"], s: ["seconde"] },
    pt: { y: ["ano"], mo: ["mês", "mes", "meses"], w: ["semana"], d: ["dia"], h: ["hora"], min: ["minuto", "min"], s: ["segundo"] },
    it: { y: ["anno", "anni"], mo: ["mese", "mesi"], w: ["settiman"], d: ["giorno", "giorni"], h: ["ore", "ora"], min: ["minut"], s: ["second"] },
  };

  // Try unit dictionaries most specific to the page first, then fall back.
  const UNIT_ORDER = ["y", "mo", "w", "d", "h", "min", "s"];

  function matchUnit(text, dict) {
    for (const u of UNIT_ORDER) {
      const words = dict[u];
      if (words && words.some((w) => text.includes(w))) return u;
    }
    return null;
  }

  /**
   * Parse a YouTube relative date label ("3 days ago", "2 місяці тому", ...).
   * Returns { date: Date, approx: boolean } or null.
   *  - hours/minutes/seconds -> today (precise enough for a day calendar)
   *  - days/weeks            -> exact day
   *  - months/years          -> approximate (same day-of-month, flagged approx)
   */
  function parseRelativeDate(text, now = new Date()) {
    if (!text) return null;
    const t = text.toLowerCase();
    const numMatch = t.match(/\d+/);
    const n = numMatch ? parseInt(numMatch[0], 10) : 1;

    let unit = matchUnit(t, UNIT_WORDS[lang2] || UNIT_WORDS.en);
    if (!unit && lang2 !== "en") unit = matchUnit(t, UNIT_WORDS.en);
    if (!unit) return null;

    const d = new Date(now.getTime());
    d.setHours(12, 0, 0, 0); // midday avoids DST edge flips
    switch (unit) {
      case "s":
      case "min":
      case "h":
        return { date: d, approx: false };
      case "d":
        d.setDate(d.getDate() - n);
        return { date: d, approx: false };
      case "w":
        // "2 тижні тому" is only week-accurate (±a few days), so flag it
        // approximate — the exact-date pass will pin it to the real day.
        d.setDate(d.getDate() - n * 7);
        return { date: d, approx: true };
      case "mo":
        d.setMonth(d.getMonth() - n);
        return { date: d, approx: true };
      case "y":
        d.setFullYear(d.getFullYear() - n);
        return { date: d, approx: true };
    }
    return null;
  }

  const dayKey = (d) =>
    `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const monthKey = (y, m) => `${y}-${m}`;

  // Turn a publish-date string into the calendar day it represents, WITHOUT a
  // timezone shift. "2026-05-04T..." must stay May 4, not roll back to May 3 in
  // a tz behind UTC, so we take the Y-M-D parts and build a local date.
  function isoToLocalDate(iso) {
    const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
    const d = new Date(iso);
    return isNaN(d) ? null : d;
  }

  /* ---------------------------------------------------------- video scrape */
  // New layout uses <yt-lockup-view-model>; older layouts use the *-renderer
  // elements. We support both and de-dupe by video id.
  const VIDEO_ITEM_SELECTOR =
    "yt-lockup-view-model, ytd-rich-item-renderer, ytd-grid-video-renderer, ytm-rich-item-renderer";

  function pickVideoId(href) {
    if (!href) return null;
    const m =
      href.match(/[?&]v=([\w-]{11})/) || href.match(/\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  function extractTitle(it, anchors) {
    // Prefer an explicit title node (old #video-title, or the new lockup title
    // anchor whose class contains "title"); fall back to the longest anchor text.
    const tEl = it.querySelector(
      '#video-title, a[href*="/watch"][class*="title" i], [class*="lockup"] [class*="title" i]'
    );
    let title = tEl
      ? (tEl.textContent || tEl.getAttribute("title") || "").trim()
      : "";
    if (!title) {
      let best = "";
      anchors.forEach((a) => {
        const t = (a.textContent || a.getAttribute("title") || "").trim();
        if (t.length > best.length) best = t;
      });
      title = best;
    }
    return title;
  }

  function extractMeta(it) {
    // New: span.ytContentMetadataViewModelMetadataText (views, …, date).
    // Old: #metadata-line spans. Date is always the last entry; views the first.
    let texts = Array.from(
      it.querySelectorAll("span.ytContentMetadataViewModelMetadataText")
    )
      .map((s) => s.textContent.trim())
      .filter(Boolean);
    if (!texts.length) {
      const metaLine = it.querySelector("#metadata-line");
      if (metaLine)
        texts = Array.from(metaLine.querySelectorAll("span"))
          .map((s) => s.textContent.trim())
          .filter(Boolean);
    }
    let views = "";
    let dateText = "";
    if (texts.length >= 2) {
      views = texts[0];
      dateText = texts[texts.length - 1];
    } else if (texts.length === 1) {
      dateText = texts[0];
    }
    return { views, dateText };
  }

  function extractDuration(it) {
    const els = it.querySelectorAll(
      ".yt-badge-shape__text, .badge-shape-wiz__text, ytd-thumbnail-overlay-time-status-renderer #text, #time-status #text"
    );
    for (const d of els) {
      const t = d.textContent.trim();
      if (/^\d{1,2}(:\d{2}){1,2}$/.test(t)) return t;
    }
    return "";
  }

  function scrapeLoaded(into = new Map()) {
    const items = document.querySelectorAll(VIDEO_ITEM_SELECTOR);
    items.forEach((it) => {
      const anchors = it.querySelectorAll(
        'a[href*="/watch?v="], a[href*="/shorts/"]'
      );
      if (!anchors.length) return;
      let id = null;
      for (const a of anchors) {
        id = pickVideoId(a.getAttribute("href"));
        if (id) break;
      }
      if (!id) return;

      const title = extractTitle(it, anchors);
      const { views, dateText } = extractMeta(it);

      const parsed = parseRelativeDate(dateText);
      if (!parsed) return; // skip live / scheduled / unparseable / playlists

      const duration = extractDuration(it);

      // Update the existing record IN PLACE so refine workers that hold a
      // reference keep pointing at the live object as more videos stream in.
      const prev = into.get(id);
      if (prev) {
        if (!prev.title && title) prev.title = title;
        if (!prev.views && views) prev.views = views;
        if (!prev.duration && duration) prev.duration = duration;
        prev.dateText = dateText;
        // Don't disturb a date we've already pinned exactly.
        if (!prev.exact && prev.approx && !parsed.approx) {
          prev.date = parsed.date;
          prev.approx = false;
        }
      } else {
        into.set(id, {
          id,
          title,
          url: `https://www.youtube.com/watch?v=${id}`,
          thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
          views,
          duration,
          dateText,
          date: parsed.date,
          approx: parsed.approx,
          exact: false,
          exactTried: false,
          refining: false,
        });
      }
    });
    return into;
  }

  /**
   * Scroll the (hidden, behind the overlay) page to lazy-load video renderers
   * into `collected` until we hit the end or the cap. `onBatch(collected)` runs
   * after every scrape so the caller can reveal/repaint progressively; return
   * false from it to abort (e.g. the overlay was closed).
   */
  async function loadVideos(cap, collected, onBatch) {
    let stagnant = 0;
    let lastCount = -1;

    while (true) {
      scrapeLoaded(collected);
      if (onBatch && onBatch(collected) === false)
        return { reachedEnd: false };

      if (collected.size >= cap) return { reachedEnd: false };

      if (collected.size === lastCount) {
        stagnant++;
        if (stagnant >= 5) return { reachedEnd: true };
      } else {
        stagnant = 0;
        lastCount = collected.size;
      }

      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(420);
    }
  }

  /* ------------------------------------------------------ exact date fetch */
  const storage =
    (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) ||
    null;

  function loadCache() {
    return new Promise((resolve) => {
      if (!storage) return resolve({});
      try {
        storage.get(CACHE_KEY, (res) =>
          resolve((res && res[CACHE_KEY]) || {})
        );
      } catch (_) {
        resolve({});
      }
    });
  }
  function saveCache(obj) {
    return new Promise((resolve) => {
      if (!storage) return resolve();
      try {
        storage.set({ [CACHE_KEY]: obj }, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  function matchPublishDate(html) {
    const m =
      html.match(/itemprop="datePublished"\s+content="([^"]+)"/) ||
      html.match(/"datePublished":"([^"]+)"/) ||
      html.match(/"uploadDate":"([^"]+)"/) ||
      html.match(/"publishDate":"([^"]+)"/);
    return m ? m[1] : null;
  }

  async function fetchExactDate(id) {
    // Same-origin fetch of the watch page; read the real publish date. The date
    // sits near the top of the HTML, so we stream and abort as soon as we find
    // it instead of downloading the whole ~1 MB page.
    const ctrl = new AbortController();
    const res = await fetch(`/watch?v=${id}`, {
      credentials: "include",
      signal: ctrl.signal,
    });
    if (!res.body || !res.body.getReader) {
      return matchPublishDate(await res.text());
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        const d = matchPublishDate(buf);
        if (d) {
          ctrl.abort();
          return d;
        }
        if (done || buf.length > 1500000) break;
      }
    } catch (_) {
      /* aborted or network error */
    }
    return matchPublishDate(buf);
  }

  // Stamp exact publish dates onto freshly-scraped records, from a session map
  // (videos refined this session) and/or the persistent storage cache.
  function applyExactInfo(videoArr, cacheObj, exactMap) {
    for (const v of videoArr) {
      let dt = null;
      if (exactMap && exactMap.has(v.id)) {
        dt = exactMap.get(v.id);
      } else if (cacheObj && cacheObj[v.id]) {
        dt = isoToLocalDate(cacheObj[v.id]);
      }
      if (dt) {
        v.date = dt;
        v.approx = false;
        v.exact = true;
        v.exactTried = true;
      }
    }
  }

  /* ====================================================================== */
  /* Calendar state + UI                                                     */
  /* ====================================================================== */
  const state = {
    videos: [],
    collected: null, // the live Map the loader fills, reused by "Load more"
    byDay: new Map(),
    monthCounts: new Map(),
    year: null,
    month: null, // 0-11
    reachedEnd: true,
    cap: DEFAULT_CAP,
    loading: false,
    refining: false,
  };

  let els = null; // cached DOM refs for the open overlay
  let savedScrollY = 0;

  // Background exact-date refinement queue.
  let refinePending = [];
  let refineTotal = 0;
  let refineDone = 0;
  let refineActive = false; // worker pool currently running
  let loadingActive = false; // videos still streaming in (keep workers alive)
  // Bumped on every open/close so an async op (loading/refining) that resumes
  // after the overlay was dismissed/reopened detects it and bails instead of
  // touching a torn-down (or replaced) `els`.
  let overlayGen = 0;

  // Monday-first weekday short names + month/year formatting via Intl.
  const fmtMonthYear = new Intl.DateTimeFormat(pageLang, {
    month: "long",
    year: "numeric",
  });
  const fmtMonthYearShort = new Intl.DateTimeFormat(pageLang, {
    month: "short",
    year: "numeric",
  });
  const fmtFullDate = new Intl.DateTimeFormat(pageLang, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const WEEKDAYS = (() => {
    const base = new Date(Date.UTC(2024, 0, 1)); // a Monday
    const f = new Intl.DateTimeFormat(pageLang, {
      weekday: "short",
      timeZone: "UTC",
    });
    return Array.from({ length: 7 }, (_, i) =>
      f.format(new Date(base.getTime() + i * 86400000))
    );
  })();

  function getChannelName() {
    const sels = [
      "yt-dynamic-text-view-model h1",
      "ytd-channel-name#channel-name #text",
      "#channel-header #channel-name #text",
      "ytd-channel-name #text",
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return document.title.replace(/\s*-\s*YouTube\s*$/i, "").trim() || "Channel";
  }

  function rebuildIndex() {
    const byDay = new Map();
    const monthCounts = new Map();
    let newest = null;
    for (const v of state.videos) {
      const dk = dayKey(v.date);
      if (!byDay.has(dk)) byDay.set(dk, []);
      byDay.get(dk).push(v);
      const mk = monthKey(v.date.getFullYear(), v.date.getMonth());
      monthCounts.set(mk, (monthCounts.get(mk) || 0) + 1);
      if (!newest || v.date > newest) newest = v.date;
    }
    // newest video first within each day
    for (const arr of byDay.values())
      arr.sort((a, b) => b.date - a.date);

    state.byDay = byDay;
    state.monthCounts = monthCounts;

    if (state.year == null || state.month == null) {
      const ref = newest || new Date();
      state.year = ref.getFullYear();
      state.month = ref.getMonth();
    }
  }

  /* ------------------------------------------------------------- rendering */
  function buildOverlay() {
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="cv-backdrop"></div>
      <div class="cv-modal" role="dialog" aria-modal="true" aria-label="Channel upload calendar">
        <header class="cv-head">
          <div class="cv-titlewrap">
            <div>
              <div class="cv-title"></div>
              <div class="cv-subtitle"></div>
            </div>
          </div>
          <div class="cv-head-actions">
            <button class="cv-btn cv-exact" type="button"></button>
            <button class="cv-iconbtn cv-close" type="button" aria-label="Close" title="Close (Esc)">✕</button>
          </div>
        </header>

        <div class="cv-nav">
          <button class="cv-iconbtn cv-prev" type="button" aria-label="Previous month" title="Previous month">‹</button>
          <div class="cv-month-label"></div>
          <button class="cv-iconbtn cv-next" type="button" aria-label="Next month" title="Next month">›</button>
          <select class="cv-month-select" aria-label="Jump to month"></select>
          <button class="cv-btn cv-latest" type="button">⤓ Latest</button>
        </div>

        <div class="cv-body">
          <div class="cv-loading">
            <div class="cv-spinner"></div>
            <div class="cv-loading-text">Loading videos…</div>
          </div>
          <div class="cv-calendar" hidden>
            <div class="cv-weekdays"></div>
            <div class="cv-grid"></div>
          </div>
          <div class="cv-empty" hidden>No videos found on this page.</div>
        </div>

        <footer class="cv-foot"></footer>
      </div>

      <div class="cv-day-detail" hidden>
        <div class="cv-day-detail-inner">
          <header class="cv-dd-head">
            <div class="cv-dd-title"></div>
            <button class="cv-iconbtn cv-dd-close" type="button" aria-label="Close">✕</button>
          </header>
          <div class="cv-dd-list"></div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    els = {
      root,
      backdrop: root.querySelector(".cv-backdrop"),
      modal: root.querySelector(".cv-modal"),
      title: root.querySelector(".cv-title"),
      subtitle: root.querySelector(".cv-subtitle"),
      exactBtn: root.querySelector(".cv-exact"),
      closeBtn: root.querySelector(".cv-close"),
      prevBtn: root.querySelector(".cv-prev"),
      nextBtn: root.querySelector(".cv-next"),
      monthLabel: root.querySelector(".cv-month-label"),
      monthSelect: root.querySelector(".cv-month-select"),
      latestBtn: root.querySelector(".cv-latest"),
      loading: root.querySelector(".cv-loading"),
      loadingText: root.querySelector(".cv-loading-text"),
      calendar: root.querySelector(".cv-calendar"),
      weekdays: root.querySelector(".cv-weekdays"),
      grid: root.querySelector(".cv-grid"),
      empty: root.querySelector(".cv-empty"),
      foot: root.querySelector(".cv-foot"),
      dayDetail: root.querySelector(".cv-day-detail"),
      ddTitle: root.querySelector(".cv-dd-title"),
      ddList: root.querySelector(".cv-dd-list"),
      ddClose: root.querySelector(".cv-dd-close"),
    };

    // weekday headers
    els.weekdays.innerHTML = WEEKDAYS.map(
      (w) => `<div class="cv-wd">${escapeHtml(w)}</div>`
    ).join("");

    // events
    els.backdrop.addEventListener("click", closeOverlay);
    els.closeBtn.addEventListener("click", closeOverlay);
    els.prevBtn.addEventListener("click", () => shiftMonth(-1));
    els.nextBtn.addEventListener("click", () => shiftMonth(1));
    els.latestBtn.addEventListener("click", goToLatest);
    els.exactBtn.addEventListener("click", onExactDates);
    els.ddClose.addEventListener("click", closeDayDetail);
    els.dayDetail.addEventListener("click", (e) => {
      if (e.target === els.dayDetail) closeDayDetail();
    });
    els.monthSelect.addEventListener("change", () => {
      const [y, m] = els.monthSelect.value.split("-").map(Number);
      state.year = y;
      state.month = m;
      renderCalendar();
    });
    els.grid.addEventListener("click", (e) => {
      const cell = e.target.closest(".cv-day.cv-has");
      if (cell) openDayDetail(cell.dataset.key);
    });

    document.addEventListener("keydown", onKeydown, true);
  }

  function onKeydown(e) {
    if (!els) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (!els.dayDetail.hidden) closeDayDetail();
      else closeOverlay();
    } else if (e.key === "ArrowLeft" && els.dayDetail.hidden) {
      shiftMonth(-1);
    } else if (e.key === "ArrowRight" && els.dayDetail.hidden) {
      shiftMonth(1);
    }
  }

  function updateExactBtn() {
    if (state.refining) {
      els.exactBtn.disabled = true;
      if (!/[%]|Refining|Fetching/.test(els.exactBtn.textContent))
        els.exactBtn.textContent = "◷ Refining…";
      els.exactBtn.title = "Fetching precise upload dates…";
      return;
    }
    const allExact =
      state.videos.length > 0 && state.videos.every((v) => v.exact);
    els.exactBtn.disabled = allExact;
    els.exactBtn.textContent = allExact ? "✓ Exact dates" : "◷ Exact dates";
    els.exactBtn.title = allExact
      ? "All upload dates are precise"
      : "Fetch exact publish dates for every video";
  }

  function refreshMonthSelect() {
    const keys = Array.from(state.monthCounts.keys()).sort((a, b) => {
      const [ay, am] = a.split("-").map(Number);
      const [by, bm] = b.split("-").map(Number);
      return by - ay || bm - am; // newest first
    });
    els.monthSelect.innerHTML = keys
      .map((k) => {
        const [y, m] = k.split("-").map(Number);
        const label = fmtMonthYearShort.format(new Date(y, m, 1));
        const count = state.monthCounts.get(k);
        return `<option value="${y}-${m}">${escapeHtml(label)} (${count})</option>`;
      })
      .join("");
  }

  function shiftMonth(delta) {
    let m = state.month + delta;
    let y = state.year;
    while (m < 0) {
      m += 12;
      y--;
    }
    while (m > 11) {
      m -= 12;
      y++;
    }
    state.month = m;
    state.year = y;
    renderCalendar();
  }

  function goToLatest() {
    let newest = null;
    for (const v of state.videos) if (!newest || v.date > newest) newest = v.date;
    if (newest) {
      state.year = newest.getFullYear();
      state.month = newest.getMonth();
      renderCalendar();
    }
  }

  function renderHeader() {
    els.title.textContent = `${getChannelName()} — ${chipLabel}`;
    const total = state.videos.length;
    const anyApprox = state.videos.some((v) => v.approx);
    const bits = [`${total} video${total === 1 ? "" : "s"}`];
    if (!state.reachedEnd) bits.push("partial");
    bits.push(anyApprox ? "approx. dates" : "exact dates");
    els.subtitle.textContent = bits.join(" · ");
    updateExactBtn();
  }

  function renderFooter() {
    const parts = [];
    const anyApprox = state.videos.some((v) => v.approx);
    if (state.refining)
      parts.push("Fetching exact upload dates… days will snap into place.");
    else if (anyApprox)
      parts.push(
        'Days marked “~” are approximate — open that month or click “◷ Exact dates” to pin the exact day.'
      );
    if (!state.reachedEnd)
      parts.push(
        `<button class="cv-btn cv-loadmore" type="button">Load more videos</button>`
      );
    els.foot.innerHTML = parts.join(" ");
    const more = els.foot.querySelector(".cv-loadmore");
    if (more) more.addEventListener("click", onLoadMore);
  }

  function renderCalendar() {
    paint();
    prioritizeRefineQueue(); // bump the now-visible month to the front
  }

  function paint() {
    if (!els) return;
    renderHeader();
    renderFooter();
    refreshMonthSelect();

    const { year, month } = state;
    els.monthLabel.textContent = fmtMonthYear.format(new Date(year, month, 1));
    els.monthSelect.value = `${year}-${month}`;

    const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    const isToday = (d) =>
      today.getFullYear() === year &&
      today.getMonth() === month &&
      today.getDate() === d;

    const cells = [];
    for (let i = 0; i < firstDow; i++)
      cells.push(`<div class="cv-day cv-blank"></div>`);

    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${month}-${d}`;
      const vids = state.byDay.get(key);
      const todayCls = isToday(d) ? " cv-today" : "";
      if (!vids || vids.length === 0) {
        cells.push(
          `<div class="cv-day cv-empty-day${todayCls}"><span class="cv-daynum">${d}</span></div>`
        );
        continue;
      }
      cells.push(renderDayCell(key, d, vids, todayCls));
    }

    // trailing blanks to complete the last week row
    while (cells.length % 7 !== 0)
      cells.push(`<div class="cv-day cv-blank"></div>`);

    els.grid.innerHTML = cells.join("");
  }

  // Reorder the pending refine queue so the currently-visible month is fetched
  // next, while every other month keeps loading in the background.
  function prioritizeRefineQueue() {
    if (refinePending.length < 2) return;
    const { year, month } = state;
    const inView = (d) =>
      d.getFullYear() === year && d.getMonth() === month ? 0 : 1;
    refinePending.sort(
      (a, b) => inView(a.date) - inView(b.date) || b.date - a.date
    );
  }

  function renderDayCell(key, dayNum, vids, todayCls) {
    const count = vids.length;
    let thumbsHtml;
    if (count === 1) {
      thumbsHtml = `<div class="cv-thumb" style="background-image:url('${vids[0].thumb}')"></div>`;
    } else {
      const shots = vids.slice(0, 4);
      const tiles = shots
        .map(
          (v) =>
            `<div class="cv-ct" style="background-image:url('${v.thumb}')"></div>`
        )
        .join("");
      thumbsHtml = `<div class="cv-collage cv-n${shots.length}">${tiles}</div>`;
    }

    const badge =
      count > 1 ? `<span class="cv-badge" title="${count} videos">${count}</span>` : "";
    const caption =
      count > 1
        ? `${count} videos`
        : vids[0].title || "";
    const approxDot = vids.some((v) => v.approx)
      ? `<span class="cv-approx" title="Approximate date">~</span>`
      : "";

    return `
      <div class="cv-day cv-has${todayCls}" data-key="${key}" title="${escapeHtml(caption)}">
        <span class="cv-daynum">${dayNum}${approxDot}</span>
        ${badge}
        ${thumbsHtml}
        <div class="cv-daytitle">${escapeHtml(caption)}</div>
      </div>`;
  }

  /* --------------------------------------------------------- day detail */
  function openDayDetail(key) {
    const vids = state.byDay.get(key);
    if (!vids || !vids.length) return;
    const [y, m, d] = key.split("-").map(Number);
    const dateObj = new Date(y, m, d);
    const approx = vids.some((v) => v.approx);
    els.ddTitle.innerHTML = `${escapeHtml(fmtFullDate.format(dateObj))} <span class="cv-dd-count">· ${vids.length} video${vids.length === 1 ? "" : "s"}</span>${approx ? ' <span class="cv-dd-approx">approx.</span>' : ""}`;

    els.ddList.innerHTML = vids
      .map((v) => {
        const meta = [v.views, v.duration].filter(Boolean).join(" · ");
        const when = v.exact
          ? fmtFullDate.format(v.date)
          : `${escapeHtml(v.dateText)}${v.approx ? " (approx.)" : ""}`;
        return `
          <a class="cv-row" href="${v.url}" target="_blank" rel="noopener noreferrer">
            <div class="cv-row-thumb" style="background-image:url('${v.thumb}')">
              ${v.duration ? `<span class="cv-row-dur">${escapeHtml(v.duration)}</span>` : ""}
            </div>
            <div class="cv-row-info">
              <div class="cv-row-title">${escapeHtml(v.title || "(untitled)")}</div>
              <div class="cv-row-meta">${escapeHtml(meta)}</div>
              <div class="cv-row-date">${when}</div>
            </div>
          </a>`;
      })
      .join("");

    els.dayDetail.hidden = false;
  }

  function closeDayDetail() {
    if (els) els.dayDetail.hidden = true;
  }

  /* ------------------------------------------------------------- actions */
  async function onLoadMore() {
    if (state.loading) return;
    const myGen = overlayGen;
    state.cap += CAP_STEP;
    state.loading = true;
    loadingActive = true;
    renderFooter(); // hide the "Load more" button while loading

    const cache = await loadCache();
    if (overlayGen !== myGen || !els) return;

    const { reachedEnd } = await loadVideos(state.cap, state.collected, (col) => {
      if (overlayGen !== myGen || !els) return false;
      state.videos = Array.from(col.values());
      applyExactInfo(state.videos, cache, null);
      rebuildIndex();
      paint();
      enqueueRefine(false);
      startRefineWorkers();
      return true;
    });
    if (overlayGen !== myGen || !els) return;

    state.reachedEnd = reachedEnd;
    state.loading = false;
    loadingActive = false;
    rebuildIndex();
    renderCalendar();
    startRefineWorkers(); // pick up any newly loaded videos
  }

  // Add videos that still need an exact date to the refine queue (skipping ones
  // exact, in-flight, or already queued). `retry` re-includes past failures.
  function enqueueRefine(retry) {
    const inQueue = new Set(refinePending.map((v) => v.id));
    let added = 0;
    for (const v of state.videos) {
      if (v.exact || v.refining || inQueue.has(v.id)) continue;
      if (!retry && v.exactTried) continue;
      refinePending.push(v);
      inQueue.add(v.id);
      added++;
    }
    refineTotal += added;
    prioritizeRefineQueue();
    return added;
  }

  // Run a pool of background workers that drain the refine queue, pinning each
  // video's exact publish date. Workers idle-wait while more videos are still
  // streaming in (loadingActive) so late arrivals get picked up too.
  async function startRefineWorkers() {
    if (refineActive || !els) return;
    if (!refinePending.length && !loadingActive) {
      updateExactBtn();
      return;
    }
    const myGen = overlayGen;
    refineActive = true;
    state.refining = true;
    refineTotal = refinePending.length;
    refineDone = 0;
    paint(); // reflect "Refining…" in the button + footer right away

    const cache = await loadCache();
    let sinceRepaint = 0;

    const worker = async () => {
      while (els && overlayGen === myGen) {
        if (!refinePending.length) {
          if (!loadingActive) break;
          await sleep(150); // wait for more videos to stream in
          continue;
        }
        const v = refinePending.shift();
        if (!v || v.exact) continue;
        v.refining = true;
        let iso = cache[v.id];
        if (!iso) {
          try {
            iso = await fetchExactDate(v.id);
          } catch (_) {
            /* network/abort */
          }
          if (iso) cache[v.id] = iso;
        }
        v.refining = false;
        v.exactTried = true;
        if (iso) {
          const dt = isoToLocalDate(iso);
          if (dt) {
            v.date = dt;
            v.approx = false;
            v.exact = true;
          }
        }
        refineDone++;
        if (els && overlayGen === myGen) {
          els.exactBtn.textContent = `◷ ${Math.min(
            100,
            Math.round((refineDone / Math.max(1, refineTotal)) * 100)
          )}%`;
          if (++sinceRepaint >= 12) {
            sinceRepaint = 0;
            rebuildIndex();
            paint();
          }
        }
      }
    };

    await Promise.all(Array.from({ length: 6 }, worker));
    await saveCache(cache);

    refineActive = false;
    if (overlayGen !== myGen || !els) return;
    state.refining = false;
    rebuildIndex();
    renderCalendar();
  }

  // Manual button: pin exact dates for everything now (also retries misses).
  function onExactDates() {
    enqueueRefine(true);
    startRefineWorkers();
  }

  /* ----------------------------------------------------------- open/close */
  async function openOverlay() {
    if (document.getElementById(ROOT_ID)) return;
    savedScrollY = window.scrollY;
    buildOverlay();
    const myGen = ++overlayGen;
    renderHeader();

    state.loading = true;
    loadingActive = true;
    els.loadingText.textContent = "Loading videos…";

    // Pre-seed the exact-date cache so already-known videos snap into place.
    const cache = await loadCache();
    if (overlayGen !== myGen || !els) return; // closed during load

    state.collected = new Map();
    let revealed = false;

    // Reveal the calendar after the FIRST batch of videos (the most recent
    // uploads — i.e. the current month) and keep loading the rest behind it.
    const { reachedEnd } = await loadVideos(state.cap, state.collected, (col) => {
      if (overlayGen !== myGen || !els) return false; // overlay closed → stop
      state.videos = Array.from(col.values());
      applyExactInfo(state.videos, cache, null);
      rebuildIndex();

      if (!revealed && col.size > 0) {
        revealed = true;
        state.loading = false;
        els.loading.hidden = true;
        els.calendar.hidden = false;
        renderCalendar(); // show current month immediately
        enqueueRefine(false); // start pinning exact dates (visible month first)
        startRefineWorkers();
      } else if (revealed) {
        paint(); // newer batches flow into their months
        enqueueRefine(false); // queue late arrivals for refinement
      } else {
        els.loadingText.textContent = `Loading videos… (${col.size})`;
      }
      return true;
    });

    if (overlayGen !== myGen || !els) return;
    state.reachedEnd = reachedEnd;
    state.loading = false;

    if (state.videos.length === 0) {
      loadingActive = false;
      els.loading.hidden = true;
      els.empty.hidden = false;
    } else {
      rebuildIndex();
      if (!revealed) {
        els.loading.hidden = true;
        els.calendar.hidden = false;
      }
      renderCalendar();
      enqueueRefine(false);
      loadingActive = false; // after the final enqueue → workers drain & exit
      startRefineWorkers();
    }
  }

  function closeOverlay() {
    if (!els) return;
    document.removeEventListener("keydown", onKeydown, true);
    els.root.remove();
    els = null;
    window.scrollTo(0, savedScrollY);
    // Invalidate any in-flight load/refine from this overlay generation.
    overlayGen++;
    refinePending = [];
    refineActive = false;
    loadingActive = false;
    // Reset so reopening (possibly on another channel) starts fresh and
    // re-centers on that channel's newest upload.
    state.videos = [];
    state.collected = null;
    state.byDay = new Map();
    state.monthCounts = new Map();
    state.year = null;
    state.month = null;
    state.cap = DEFAULT_CAP;
    state.reachedEnd = true;
    state.loading = false;
    state.refining = false;
  }

  /* ====================================================================== */
  /* Chip injection + SPA lifecycle                                          */
  /* ====================================================================== */
  const VIDEOS_PATH_RE =
    /\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/videos\b/;

  function onVideosPage() {
    return VIDEOS_PATH_RE.test(location.pathname);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findChipBar() {
    // Current layout: New / Popular / Oldest chips are <chip-shape> elements
    // inside a flex scroll container in the rich-grid header.
    const candidates = [
      ...document.querySelectorAll(
        "ytd-rich-grid-renderer #header .ytChipBarViewModelChipBarScrollContainer"
      ),
      ...document.querySelectorAll(".ytChipBarViewModelChipBarScrollContainer"),
      ...document.querySelectorAll("chip-bar-view-model > div"),
      // Older layout fallback.
      ...document.querySelectorAll("ytd-feed-filter-chip-bar-renderer #chips"),
      ...document.querySelectorAll("ytd-feed-filter-chip-bar-renderer"),
      // Last resort: whatever row currently holds a chip.
      ...Array.from(
        document.querySelectorAll(".ytChipShapeChip, yt-chip-cloud-chip-renderer")
      )
        .map((chip) =>
          chip.closest(".ytChipBarViewModelChipBarScrollContainer, #chips") ||
          chip.closest('[class*="ScrollContainer"]') ||
          chip.parentElement
        )
        .filter(Boolean),
    ];

    return (
      candidates.find((bar) => {
        if (!isVisible(bar)) return false;
        return bar.querySelector(
          ".ytChipShapeChip, yt-chip-cloud-chip-renderer, [role='tab'], button"
        );
      }) ||
      candidates.find(isVisible) ||
      candidates[0] ||
      null
    );
  }

  function makeChip() {
    const chip = document.createElement("button");
    chip.id = CHIP_ID;
    chip.className = "cv-chip";
    chip.type = "button";
    chip.textContent = chipLabel;
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openOverlay();
    });
    return chip;
  }

  function ensureChip() {
    const existing = document.getElementById(CHIP_ID);
    if (!onVideosPage()) {
      if (existing) existing.remove();
      return;
    }
    const bar = findChipBar();
    if (!bar) return;
    if (existing && existing.isConnected) {
      if (existing.parentElement !== bar || !isVisible(existing)) {
        existing.remove();
        bar.appendChild(makeChip());
      }
      return;
    }
    bar.appendChild(makeChip());
  }

  // YouTube is a SPA: react to navigation + DOM churn, with a polling safety net.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        ensureChip();
      } catch (e) {
        /* noop */
      }
    });
  }

  function scheduleSoon() {
    schedule();
    setTimeout(schedule, 250);
    setTimeout(schedule, 750);
    setTimeout(schedule, 1500);
  }

  window.addEventListener("yt-navigate-start", scheduleSoon);
  window.addEventListener("yt-navigate-finish", scheduleSoon);
  window.addEventListener("yt-page-data-updated", scheduleSoon);
  window.addEventListener("popstate", scheduleSoon);
  document.addEventListener("yt-action", scheduleSoon);

  const { pushState, replaceState } = history;
  history.pushState = function (...args) {
    const ret = pushState.apply(this, args);
    scheduleSoon();
    return ret;
  };
  history.replaceState = function (...args) {
    const ret = replaceState.apply(this, args);
    scheduleSoon();
    return ret;
  };

  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Belt-and-suspenders: YouTube sometimes swaps the chip bar without firing
  // an event we catch. A cheap periodic check keeps the chip present.
  setInterval(schedule, 1500);

  schedule();
  console.debug(`${LOG} loaded`);
})();
