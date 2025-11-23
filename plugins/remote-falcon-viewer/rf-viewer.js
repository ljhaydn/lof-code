(function () {
  const base = (window.RFViewer && RFViewer.base) ? RFViewer.base : '';

  const viewerRoot  = document.getElementById('rf-viewer');
  const statusPanel = document.querySelector('.rf-status-panel');
  const gridEl      = document.getElementById('rf-grid');

  const nowCardEl   = document.querySelector('.rf-now');
  const nowTitleEl  = document.getElementById('rf-now-title');
  const nowArtistEl = document.getElementById('rf-now-artist');
  const nextTitleEl = document.getElementById('rf-next-title');
  const modeEl      = document.getElementById('rf-mode-value');

  // Persist stream state across re-renders of the extras panel
const lofStreamState = {
  init: false,
  visible: false
};

  // -----------------------------
  // LOF EXTRAS CONFIG
  // -----------------------------
  const LOFViewer = {
    config: null,
    configLoaded: false
  };

  function lofCopy(key, fallback) {
    try {
      if (
        LOFViewer &&
        LOFViewer.config &&
        LOFViewer.config.copy &&
        typeof LOFViewer.config.copy[key] === 'string'
      ) {
        const val = LOFViewer.config.copy[key];
        if (val && val.trim() !== '') {
          return val;
        }
      }
    } catch (e) {}
    return fallback;
  }

  function getLofConfig() {
    return (LOFViewer && LOFViewer.config) ? LOFViewer.config : null;
  }

  function applyTokens(template, tokens) {
    if (typeof template !== 'string' || !tokens) return template;
    return template.replace(/\{(\w+)\}/g, function (_, key) {
      return Object.prototype.hasOwnProperty.call(tokens, key)
        ? String(tokens[key])
        : '{' + key + '}';
    });
  }

  function lofLoadConfig() {
    // If LOF Extras plugin is not installed or the endpoint errors out,
    // we don't want to break the viewer – just log and move on.
    fetch('/wp-json/lof-extras/v1/viewer-config', {
      method: 'GET',
      credentials: 'same-origin'
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        LOFViewer.config = data;
        LOFViewer.configLoaded = true;
        console.log('[LOF] Extras viewer-config loaded:', data);
        // Banner + header will be updated the next time renderShowDetails runs.
      })
      .catch(function (err) {
        console.warn('[LOF] Could not load viewer-config from LOF Extras:', err);
      });
  }

  let lastActionTimes = {};
  const ACTION_COOLDOWN = 15000; // 15s

let currentMode = 'UNKNOWN';
let currentControlEnabled = false;
let currentVisibleSequences = [];
let currentPrefs = {};
let currentNowKey = null;
let currentQueueCounts = {};
let lastCountedNowKey = null;

// Global guardrails
let lastGlobalActionTime = 0;
const GLOBAL_ACTION_COOLDOWN = 5000; // 5s between any actions from this device

  // Local “identity” for this device
  const STORAGE_REQUESTS_KEY = 'lofRequestedSongs_v1';
  const STORAGE_STATS_KEY    = 'lofViewerStats_v1';
  const STORAGE_GLOW_KEY     = 'lofGlowLastTime_v1';
  const STORAGE_PLAYED_KEY   = 'lofPlayedCounts_v1';

  let requestedSongNames = loadRequestedSongs();
  let viewerStats        = loadStats();
  let playedCounts       = loadPlayedCounts();

  // last requested song (name) this session
  let lastRequestedSequenceName = null;
  // cache last phase for banner logic
  let lastPhase = 'idle';

  /* -------------------------
   * Local storage helpers
   * ------------------------- */

  function loadRequestedSongs() {
    try {
      const raw = window.localStorage.getItem(STORAGE_REQUESTS_KEY);
      if (!raw) return [];
      const val = JSON.parse(raw);
      return Array.isArray(val) ? val : [];
    } catch (e) {
      return [];
    }
  }

  function saveRequestedSongs() {
    try {
      window.localStorage.setItem(STORAGE_REQUESTS_KEY, JSON.stringify(requestedSongNames));
    } catch (e) {}
  }

  function loadStats() {
    const today = new Date();
    const dayKey = today.toISOString().slice(0, 10); // yyyy-mm-dd

    try {
      const raw = window.localStorage.getItem(STORAGE_STATS_KEY);
      if (!raw) {
        return { day: dayKey, requests: 0, surprise: 0 };
      }
      const val = JSON.parse(raw) || {};
      if (val.day !== dayKey) {
        return { day: dayKey, requests: 0, surprise: 0 };
      }
      return {
        day: dayKey,
        requests: val.requests || 0,
        surprise: val.surprise || 0
      };
    } catch (e) {
      return { day: dayKey, requests: 0, surprise: 0 };
    }
  }

  function saveStats() {
    try {
      window.localStorage.setItem(STORAGE_STATS_KEY, JSON.stringify(viewerStats));
    } catch (e) {}
  }

  function loadPlayedCounts() {
    const today = new Date();
    const dayKey = today.toISOString().slice(0, 10); // yyyy-mm-dd

    try {
      const raw = window.localStorage.getItem(STORAGE_PLAYED_KEY);
      if (!raw) {
        return { day: dayKey, counts: {} };
      }
      const val = JSON.parse(raw) || {};
      if (val.day !== dayKey || !val.counts || typeof val.counts !== 'object') {
        return { day: dayKey, counts: {} };
      }
      return {
        day: dayKey,
        counts: val.counts
      };
    } catch (e) {
      return { day: dayKey, counts: {} };
    }
  }

  function savePlayedCounts() {
    try {
      window.localStorage.setItem(STORAGE_PLAYED_KEY, JSON.stringify(playedCounts));
    } catch (e) {}
  }

  function incrementPlayedCount(key) {
    if (!key) return;
    try {
      const todayKey = new Date().toISOString().slice(0, 10);
      if (!playedCounts || playedCounts.day !== todayKey || !playedCounts.counts) {
        playedCounts = { day: todayKey, counts: {} };
      }
      const counts = playedCounts.counts;
      const current = parseInt(counts[key], 10);
      counts[key] = isNaN(current) ? 1 : current + 1;
      savePlayedCounts();
    } catch (e) {}
  }

  function getPlayedCount(key) {
    if (!key || !playedCounts || !playedCounts.counts) return 0;
    const val = playedCounts.counts[key];
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  }

function syncRequestedSongsWithStatus(nowSeq, queue) {
  if (!Array.isArray(requestedSongNames) || requestedSongNames.length === 0) {
    requestedSongNames = [];
    saveRequestedSongs();
    return;
  }

  const active = new Set();

  // Now playing might match one or more requested titles
  if (nowSeq) {
    const nowName = nowSeq.name || nowSeq.displayName;
    if (nowName) active.add(nowName);
  }

  // Anything still in the RF queue stays active
  if (Array.isArray(queue)) {
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (!item || typeof item !== 'object') continue;
      const seq = item.sequence || {};
      const sName = seq.name || seq.displayName;
      if (sName && requestedSongNames.includes(sName)) {
        active.add(sName);
      }
    }
  }

  // Keep only ones still active
  requestedSongNames = requestedSongNames.filter((name) => active.has(name));
  saveRequestedSongs();
}
  function getLastGlowTime() {
    try {
      const raw = window.localStorage.getItem(STORAGE_GLOW_KEY);
      if (!raw) return 0;
      const t = parseInt(raw, 10);
      return isNaN(t) ? 0 : t;
    } catch (e) {
      return 0;
    }
  }

  function saveLastGlowTime(ts) {
    try {
      window.localStorage.setItem(STORAGE_GLOW_KEY, String(ts));
    } catch (e) {}
  }

  /* -------------------------
   * Toast
   * ------------------------- */

  function showToast(message, type = 'success') {
    let toast = document.getElementById('rf-toast');

    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'rf-toast';
      toast.className = 'rf-toast';
      document.body.appendChild(toast);
    }

    toast.classList.remove('rf-toast--success', 'rf-toast--error');

    if (type === 'error') {
      toast.classList.add('rf-toast--error');
    } else {
      toast.classList.add('rf-toast--success');
    }

    toast.textContent = message;
    toast.classList.add('show');

    setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  /* -------------------------
   * Fetch showDetails via WP proxy
   * ------------------------- */

  async function fetchShowDetails() {
    if (!base) return;

    try {
      const res = await fetch(base + '/showDetails');
      if (!res.ok) {
        console.error('[RF] showDetails error:', res.status);
        return;
      }

      const data = await res.json();
      renderShowDetails(data);
    } catch (err) {
      console.error('[RF] showDetails fetch error:', err);
    }
  }

  /* -------------------------
   * Header + Layout helpers
   * ------------------------- */

  function ensureHeader() {
    if (!viewerRoot || !statusPanel) return;

    let header = document.getElementById('rf-viewer-header');
    if (!header) {
      header = document.createElement('div');
      header.id = 'rf-viewer-header';
      header.className = 'rf-viewer-header';

      const headline = document.createElement('div');
      headline.id = 'rf-viewer-headline';
      headline.className = 'rf-viewer-headline';

      const subcopy = document.createElement('div');
      subcopy.id = 'rf-viewer-subcopy';
      subcopy.className = 'rf-viewer-subcopy';

      const myStatus = document.createElement('div');
      myStatus.id = 'rf-viewer-my-status';
      myStatus.className = 'rf-viewer-my-status';

      const controls = document.createElement('div');
      controls.id = 'rf-viewer-controls';
      controls.className = 'rf-viewer-controls';

      header.appendChild(headline);
      header.appendChild(subcopy);
      header.appendChild(myStatus);
      header.appendChild(controls);

      viewerRoot.insertBefore(header, statusPanel);
    }
  }

  function ensureBanner() {
    if (!viewerRoot) return;

    let banner = document.getElementById('rf-viewer-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'rf-viewer-banner';
      banner.className = 'rf-viewer-banner';
      // lightweight inline baseline styling so it doesn't look broken even without CSS
      banner.style.padding = '0.75rem 1rem';
      banner.style.marginBottom = '0.75rem';
      banner.style.borderRadius = '0.75rem';
      banner.style.background = 'rgba(0,0,0,0.25)';
      banner.style.backdropFilter = 'blur(6px)';
      banner.style.color = 'inherit';

      const title = document.createElement('div');
      title.id = 'rf-banner-title';
      title.style.fontWeight = '600';

      const body = document.createElement('div');
      body.id = 'rf-banner-body';
      body.style.fontSize = '0.9rem';
      body.style.opacity = '0.9';

      banner.appendChild(title);
      banner.appendChild(body);

      // Insert banner above header (if header exists), otherwise above status panel.
      const header = document.getElementById('rf-viewer-header');
      if (header && header.parentNode === viewerRoot) {
        viewerRoot.insertBefore(banner, header);
      } else if (statusPanel) {
        viewerRoot.insertBefore(banner, statusPanel);
      } else {
        viewerRoot.insertBefore(banner, viewerRoot.firstChild);
      }
    }
  }

  function ensureControls() {
    return;
  }

  function ensureMainLayout() {
    if (!viewerRoot || !gridEl) return;

    if (!viewerRoot.querySelector('.rf-main-layout')) {
      const layout = document.createElement('div');
      layout.className = 'rf-main-layout';

      const leftCol = document.createElement('div');
      leftCol.className = 'rf-main-left';

      const rightCol = document.createElement('div');
      rightCol.className = 'rf-main-right';

      const extraPanel = document.createElement('div');
      extraPanel.id = 'rf-extra-panel';
      extraPanel.className = 'rf-extra-panel';

      viewerRoot.removeChild(gridEl);
      leftCol.appendChild(gridEl);
      rightCol.appendChild(extraPanel);

      layout.appendChild(leftCol);
      layout.appendChild(rightCol);

      viewerRoot.appendChild(layout);
    }
  }

  function isLateNight() {
    try {
      const now = new Date();
      const hour = now.getHours();
      return hour >= 22;
    } catch (e) {
      return false;
    }
  }

  function getShowState(phase) {
    const config = getLofConfig();
    const holidayMode = config && config.holiday_mode ? String(config.holiday_mode) : 'offseason';
    const showtimes = (config && Array.isArray(config.showtimes)) ? config.showtimes : [];

    // If explicitly offseason, that wins.
    if (holidayMode === 'offseason') {
      return 'offseason';
    }

    let inWindow = false;
    if (showtimes.length) {
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();

      for (let i = 0; i < showtimes.length; i++) {
        const win = showtimes[i];
        if (!win || typeof win !== 'object') continue;
        const startStr = win.start || '';
        const endStr   = win.end || '';
        if (!startStr || !endStr) continue;

        const partsStart = startStr.split(':');
        const partsEnd   = endStr.split(':');
        if (partsStart.length < 2 || partsEnd.length < 2) continue;

        const sH = parseInt(partsStart[0], 10);
        const sM = parseInt(partsStart[1], 10);
        const eH = parseInt(partsEnd[0], 10);
        const eM = parseInt(partsEnd[1], 10);
        if (isNaN(sH) || isNaN(sM) || isNaN(eH) || isNaN(eM)) continue;

        const startMin = sH * 60 + sM;
        const endMin   = eH * 60 + eM;

        if (nowMinutes >= startMin && nowMinutes < endMin) {
          inWindow = true;
          break;
        }
      }
    }

    if (inWindow) {
      if (phase === 'intermission') return 'intermission';
      return 'showtime';
    }

    // Not in a show window
    if (phase === 'intermission' || phase === 'showtime') {
      // If RF says something is playing or intermission but we're outside schedule,
      // treat it as after-hours glow.
      return 'afterhours';
    }

    // default: afterhours vs offseason (offseason handled at top)
    return 'afterhours';
  }

  function updateBanner(phase) {
    ensureBanner();

    const banner    = document.getElementById('rf-viewer-banner');
    const titleEl   = document.getElementById('rf-banner-title');
    const bodyEl    = document.getElementById('rf-banner-body');
    if (!banner || !titleEl || !bodyEl) return;

    const config      = getLofConfig();
    const holidayMode = config && config.holiday_mode ? String(config.holiday_mode) : 'offseason';

    const showState = getShowState(phase); // showtime | intermission | afterhours | offseason

    // Clear CSS classes and re-apply based on holiday mode + showState
    banner.className = 'rf-viewer-banner';
    banner.classList.add('rf-banner--' + showState);
    banner.classList.add('rf-banner-holiday--' + holidayMode);

    let titleKey, bodyKey;

    if (showState === 'offseason') {
      titleKey = 'banner_offseason_title';
      bodyKey  = 'banner_offseason_sub';
    } else if (showState === 'afterhours') {
      titleKey = 'banner_afterhours_title';
      bodyKey  = 'banner_afterhours_sub';
    } else if (showState === 'intermission') {
      titleKey = 'banner_intermission_title';
      bodyKey  = 'banner_intermission_sub';
    } else {
      // showtime
      titleKey = 'banner_showtime_title';
      bodyKey  = 'banner_showtime_sub';
    }

    const titleText = lofCopy(titleKey, titleEl.textContent || '');
    const bodyText  = lofCopy(bodyKey, bodyEl.textContent || '');

    titleEl.textContent = titleText || '';
    bodyEl.textContent  = bodyText || '';
  }

  function applyPersonaToSubcopy(subcopyEl) {
    if (!subcopyEl) return;

    const count = (viewerStats && typeof viewerStats.requests === 'number')
      ? viewerStats.requests
      : 0;

    let extra = '';

    if (count === 1) {
      extra = ' You just joined the queue — welcome to the chaos. 🎄';
    } else if (count >= 3 && count < 10) {
      extra = ' You’re officially part of the neighborhood DJ crew.';
    } else if (count >= 10) {
      extra = ' You, friend, are running this street.';
    }

    if (!extra) return;

    const base = subcopyEl.textContent || '';
    subcopyEl.textContent = base + extra;
  }

  function updateHeaderCopy(mode, enabled, prefs, queueLength, phase) {
    const headlineEl = document.getElementById('rf-viewer-headline');
    const subcopyEl  = document.getElementById('rf-viewer-subcopy');
    if (!headlineEl || !subcopyEl) return;

    const requestLimit   = prefs.jukeboxRequestLimit || null;
    const locationMethod = prefs.locationCheckMethod || 'NONE';

    const late = isLateNight();
    let parts = [];

    // Phase contribution (pre-header flavor)
    if (phase === 'intermission') {
      // We can optionally prepend intermission flavor here if we want;
      // the main banner now carries most of that weight.
    } else if (phase === 'showtime') {
      // Likewise, banner covers most of the "showtime" vibe.
    }

    if (!enabled) {
      const title = lofCopy(
        'header_paused_title',
        'Viewer control is currently paused'
      );
      const body  = lofCopy(
        'header_paused_body',
        'You can still enjoy the show — we’ll turn song requests and voting back on soon.'
      );
      headlineEl.textContent = title;
      subcopyEl.textContent  = body;
      applyPersonaToSubcopy(subcopyEl);
      return;
    }

    if (mode === 'JUKEBOX') {
      const title = lofCopy(
        'header_jukebox_title',
        'Tap a song to request it 🎧'
      );
      headlineEl.textContent = title;

      const tokens = {
        queueCount: queueLength,
        requestLimit: requestLimit || ''
      };

      const intro = lofCopy(
        'header_jukebox_intro',
        'Requests join the queue in the order they come in.'
      );
      parts.push(intro);

      if (queueLength > 0) {
        const queueLineTmpl = lofCopy(
          'header_jukebox_queue',
          'There are currently {queueCount} songs in the queue.'
        );
        parts.push(applyTokens(queueLineTmpl, tokens));
      }

      if (requestLimit && requestLimit > 0) {
        const limitLineTmpl = lofCopy(
          'header_jukebox_limit',
          'You can request up to {requestLimit} songs per session.'
        );
        parts.push(applyTokens(limitLineTmpl, tokens));
      }

      if (locationMethod && locationMethod !== 'NONE') {
        parts.push(
          lofCopy(
            'header_jukebox_geo',
            'Viewer control may be limited to guests near the show location.'
          )
        );
      }

      if (late) {
        parts.push(
          lofCopy(
            'header_jukebox_late',
            'Late-night Falcon fans are the real MVPs. 🌙'
          )
        );
      }

      subcopyEl.textContent = parts.join(' ');
      applyPersonaToSubcopy(subcopyEl);
      return;
    }

    if (mode === 'VOTING') {
      const title = lofCopy(
        'header_voting_title',
        'Vote for your favorites 🗳️'
      );
      const intro = lofCopy(
        'header_voting_intro',
        'Songs with the most votes rise to the top. Tap a track below to help decide what plays next.'
      );
      headlineEl.textContent = title;
      parts.push(intro);

      if (late) {
        parts.push(
          lofCopy(
            'header_voting_late',
            'Bonus points for after-dark voting energy. 🌒'
          )
        );
      }

      subcopyEl.textContent = parts.join(' ');
      applyPersonaToSubcopy(subcopyEl);
      return;
    }

    const fallbackTitle = lofCopy(
      'header_default_title',
      'Interactive show controls'
    );
    const fallbackBody = lofCopy(
      'header_default_body',
      'Use the controls below to interact with the Lights on Falcon show in real time.'
    );

    headlineEl.textContent = fallbackTitle;
    subcopyEl.textContent  = fallbackBody;
    applyPersonaToSubcopy(subcopyEl);
  }

  function updateMyStatusLine(nowSeq, queue, nowKey) {
    const el = document.getElementById('rf-viewer-my-status');
    if (!el) return;

    if (!Array.isArray(requestedSongNames) || requestedSongNames.length === 0) {
      el.textContent = '';
      el.style.display = 'none';
      return;
    }

    let nowMatches = [];
    let queueMatches = [];

    const nowName = nowSeq ? (nowSeq.name || nowSeq.displayName) : null;
    if (nowName && requestedSongNames.includes(nowName)) {
      nowMatches.push(nowName);
    }

    if (Array.isArray(queue)) {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        if (!item || typeof item !== 'object') continue;
        const seq = item.sequence || {};
        const sName = seq.name || seq.displayName;
        if (!sName) continue;
        if (requestedSongNames.includes(sName)) {
          // Use the current index + 1 so the position tracks live queue order,
          // even if RF's stored "position" is not updated as the queue drains.
          const pos = i + 1;
          queueMatches.push({ name: sName, pos });
        }
      }
    }

    let text = '';
    if (nowMatches.length > 0) {
      if (nowMatches.length === 1) {
        text = `Your request “${nowMatches[0]}” is playing right now. Enjoy the glow ✨`;
      } else {
        text = `One of your picks is playing now! (${nowMatches.join(', ')})`;
      }
    } else if (queueMatches.length > 0) {
      if (queueMatches.length === 1) {
        const item = queueMatches[0];
        text = `Your song “${item.name}” is currently #${item.pos} in the queue.`;
      } else {
        const parts = queueMatches
          .sort((a, b) => a.pos - b.pos)
          .map((x) => `“${x.name}” (#${x.pos})`);
        text = `Your picks are moving up: ${parts.join(', ')}`;
      }
    } else {
      text = 'Your previous requests have played. Pick another to keep the show moving. 🎶';
    }

    el.textContent = text;
    el.style.display = 'block';

    // Keep requested chips synced
    syncRequestedSongsWithStatus(nowSeq, queue);
  }

  /* -------------------------
   * Now Playing progress helpers
   * ------------------------- */

  function lofFormatTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  function updateNowProgress(nowInfo) {
    const wrap  = document.querySelector('.rf-now-progress');
    const fill  = document.querySelector('.rf-now-progress-fill');
    const label = document.querySelector('.rf-now-progress-label');

    if (!wrap || !fill || !label) return;

    // No timing info or no active song – clear and hide the bar
    if (!nowInfo || typeof nowInfo.duration !== 'number' || typeof nowInfo.elapsed !== 'number') {
      wrap.style.display = 'none';
      label.textContent = '';
      fill.style.width = '0%';
      return;
    }

    const total = Math.max(1, nowInfo.duration);
    const elapsed = Math.min(Math.max(0, nowInfo.elapsed), total);
    const remaining = total - elapsed;
    const pct = (elapsed / total) * 100;

    wrap.style.display = 'block';
    fill.style.width = pct + '%';

    if (remaining <= 3) {
      label.textContent = 'Wrapping up…';
    } else {
      label.textContent = lofFormatTime(remaining) + ' remaining';
    }
  
  }
  function tickNowProgress() {
    if (typeof window === 'undefined') return;
    const timing = window.LOFNowTiming;
    if (!timing || typeof timing.duration !== 'number') return;

    const baseElapsed = typeof timing.elapsed === 'number' ? timing.elapsed : 0;
    const startedAt   = typeof timing.updatedAt === 'number' ? timing.updatedAt : Date.now();
    const now         = Date.now();
    const deltaSec    = Math.max(0, (now - startedAt) / 1000);

    const duration = Math.max(1, timing.duration);
    const elapsed  = Math.min(duration, baseElapsed + deltaSec);

    updateNowProgress({
      duration: duration,
      elapsed: elapsed
    });
  }

  /* -------------------------
   * Controls row under status
   * ------------------------- */
  function renderControlsRow(mode, enabled) {
    const row = document.getElementById('rf-controls-row');
    if (!row) return;

    // Clear and rebuild each time to avoid duplicate listeners
    row.innerHTML = '';

    const makeBtn = (label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rf-ctl-link';
      b.textContent = label;
      return b;
    };

    // Need sound? → scroll to the speaker card / extras panel
    const btnSound = makeBtn('Need sound?');
    btnSound.addEventListener('click', () => {
      const target =
        document.querySelector('.rf-speaker-card') ||
        document.getElementById('rf-extra-panel');
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    row.appendChild(btnSound);

    // Send a Glow → scroll to footer Glow section
    const btnGlow = makeBtn('Send a Glow 💛');
    btnGlow.addEventListener('click', () => {
      const target =
        document.querySelector('.rf-tonight') ||
        document.getElementById('rf-footer-glow');
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    row.appendChild(btnGlow);

    // Surprise me → trigger surprise logic and scroll to the card, when enabled
    if (enabled) {
      const btnSurprise = makeBtn('Surprise me ✨');
      btnSurprise.addEventListener('click', () => {
        handleSurpriseMe();
        const target = document.querySelector('.rf-card--surprise');
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      row.appendChild(btnSurprise);
      row.classList.remove('rf-controls-row--disabled');
    } else {
      row.classList.add('rf-controls-row--disabled');
    }
  }

  /* -------------------------
   * Main render
   * ------------------------- */

  function renderShowDetails(data) {
    if (!data || typeof data !== 'object') return;

    const prefs        = data.preferences || {};
    currentPrefs = prefs || {};
    const sequences    = Array.isArray(data.sequences) ? data.sequences : [];
    const rawRequests  = Array.isArray(data.requests) ? data.requests : [];
    const rawVotes     = Array.isArray(data.votes)    ? data.votes    : [];

    // Compute live queue counts by sequence key
    currentQueueCounts = {};
    if (Array.isArray(rawRequests)) {
      rawRequests.forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        const seqObj = (item.sequence && typeof item.sequence === 'object') ? item.sequence : {};
        const key = seqObj.name || seqObj.displayName;
        if (!key) return;
        currentQueueCounts[key] = (currentQueueCounts[key] || 0) + 1;
      });
    }

    currentMode           = prefs.viewerControlMode || 'UNKNOWN';
    currentControlEnabled = !!prefs.viewerControlEnabled;

    if (typeof currentMode === 'string') {
      currentMode = currentMode.toUpperCase();
    }

    const modeLabel = formatModeLabel(currentMode, currentControlEnabled);

    const playingNowRaw  = data.playingNow || '';
    const playingNextRaw = data.playingNext || '';

    ensureHeader();
    ensureMainLayout();
    ensureBanner();

    const nowSeq = sequences.find(
      (s) => s.name === playingNowRaw || s.displayName === playingNowRaw
    ) || null;

    let nextSeq = sequences.find(
      (s) => s.name === playingNextRaw || s.displayName === playingNextRaw
    ) || null;

    if (!nextSeq && rawRequests.length > 0 && rawRequests[0].sequence) {
      nextSeq = rawRequests[0].sequence;
    }

    const nowDisplay = nowSeq
      ? (nowSeq.displayName || nowSeq.name || playingNowRaw)
      : (playingNowRaw || 'Nothing currently playing');

    const nextDisplay = nextSeq
      ? (nextSeq.displayName || nextSeq.name || playingNextRaw)
      : (playingNextRaw || '—');

    const nowArtist = nowSeq && nowSeq.artist ? nowSeq.artist : '';

    const nowKey  = nowSeq  ? (nowSeq.name  || nowSeq.displayName) : playingNowRaw;
    const nextKey = nextSeq ? (nextSeq.name || nextSeq.displayName) : playingNextRaw;
    currentNowKey = nowKey || null;

    // DIM LOGIC (uses display title):
    const hasRawNow      = !!(playingNowRaw && playingNowRaw.toString().trim());
    const isIntermission = nowDisplay && /intermission/i.test(nowDisplay);
    const isStandby      = nowDisplay && /standby/i.test(nowDisplay);
    const isPlayingReal  = hasRawNow && !isIntermission && !isStandby;

    if (isPlayingReal && nowKey && nowKey !== lastCountedNowKey) {
      incrementPlayedCount(nowKey);
      lastCountedNowKey = nowKey;
    }

    if (viewerRoot) {
      viewerRoot.classList.toggle('rf-phase-intermission', isIntermission);
      viewerRoot.classList.toggle('rf-phase-showtime', isPlayingReal);
    }

    if (nowCardEl) {
      nowCardEl.classList.toggle('rf-now--dim', !isPlayingReal);
    }

    if (modeEl)      modeEl.textContent      = modeLabel;
    if (nowTitleEl)  nowTitleEl.textContent  = nowDisplay;
    if (nextTitleEl) nextTitleEl.textContent = nextDisplay;
    if (nowArtistEl) nowArtistEl.textContent = nowArtist;

    // (Now Playing progress bar handled by FPP status polling)

    const queueLength = rawRequests.length || 0;
    const phase = isIntermission ? 'intermission' : (isPlayingReal ? 'showtime' : 'idle');
    lastPhase = phase;

    updateHeaderCopy(currentMode, currentControlEnabled, prefs, queueLength, phase);
    updateBanner(phase);
    updateMyStatusLine(nowSeq, rawRequests, nowKey);
    renderControlsRow(currentMode, currentControlEnabled);

    if (!gridEl) return;
    gridEl.innerHTML = '';

    const visibleSequences = sequences
      .filter((s) => s.visible && s.active)
      .sort((a, b) => {
        const ao = typeof a.order === 'number' ? a.order : 9999;
        const bo = typeof b.order === 'number' ? b.order : 9999;
        return ao - bo;
      });

    currentVisibleSequences = visibleSequences;

    visibleSequences.forEach((seq) => {
      const card = document.createElement('div');
      card.className = 'rf-card';

      const isNow  = nowKey  && (seq.name === nowKey  || seq.displayName === nowKey);
      const isNext = nextKey && (seq.name === nextKey || seq.displayName === nextKey);

      if (isNow) {
        card.classList.add('rf-card--now-playing');
      } else if (isNext) {
        card.classList.add('rf-card--next');
      }

      const durationSeconds = seq.duration || 0;
      const minutes = Math.floor(durationSeconds / 60);
      const seconds = durationSeconds % 60;
      const niceDuration = minutes + ':' + String(seconds).padStart(2, '0');

      const buttonLabel  = getButtonLabel(currentMode, currentControlEnabled);
      const displayTitle = seq.displayName || seq.name || 'Untitled';
      const artist       = seq.artist || '';

      card.innerHTML = `
        <div class="rf-card-title">${escapeHtml(displayTitle)}</div>
        <div class="rf-card-artist">${escapeHtml(artist)}</div>
        <div class="rf-card-meta">
          <span class="rf-card-duration">Runtime ${niceDuration}</span>
        </div>
        <div class="rf-card-actions">
          <button class="rf-card-btn" ${!currentControlEnabled ? 'disabled' : ''}>
            ${escapeHtml(buttonLabel)}
          </button>
        </div>
      `;

      const seqName = seq.name || seq.displayName;
      const wasRequested = seqName && requestedSongNames.indexOf(seqName) !== -1;

      if (wasRequested) {
        const chip = document.createElement('div');
        chip.className = 'rf-card-chip';
        if (isNow) {
          chip.textContent = 'Your pick is playing ✨';
        } else {
          chip.textContent = 'You picked this';
        }
        card.appendChild(chip);
      }

      if (isNow || isNext) {
        card.classList.add('rf-card--with-badge');

        const badge = document.createElement('div');
        badge.className =
          'rf-card-badge ' + (isNow ? 'rf-card-badge--now' : 'rf-card-badge--next');
        badge.textContent = isNow ? 'Now playing' : 'Next up';
        card.appendChild(badge);
      }

      const btn = card.querySelector('.rf-card-btn');
      if (btn && currentControlEnabled) {
        btn.addEventListener('click', () => handleAction(currentMode, seq, btn));
      }

      gridEl.appendChild(card);
    });

    addSurpriseCard();
    renderExtraPanel(currentMode, currentControlEnabled, data, queueLength);
  }

  /* -------------------------
   * FPP Now Playing timing (for progress bar)
   * ------------------------- */
  async function fetchFppStatus() {
    try {
      const res = await fetch('/wp-json/lof-extras/v1/fpp/status', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });

      if (!res.ok) {
        console.warn('[LOF Viewer] FPP status HTTP error:', res.status);
        updateNowProgress(null);
        return;
      }

      const data = await res.json().catch(() => null);
      if (!data || typeof data !== 'object' || data.success !== true) {
        updateNowProgress(null);
        return;
      }

      const statusName = String(data.status_name || '').toLowerCase();
      const played     = parseInt(data.seconds_played, 10);
      const remaining  = parseInt(data.seconds_remaining, 10);
      const playlist   = String(data.playlist_name || '').toLowerCase();

      const hasPlayed     = !isNaN(played);
      const hasRemaining  = !isNaN(remaining);
      const duration      = (hasPlayed && hasRemaining) ? (played + remaining) : null;

      // Treat <= 1s remaining as done
      const nearlyDone = hasRemaining && remaining <= 1;

      // Determine whether we should show the bar:
      // Only when FPP is playing AND we are in showtime AND not intermission
      const phase = lastPhase || 'idle';
      const isIntermission = playlist.includes('intermission');

      const shouldShow =
        statusName === 'playing' &&
        duration != null &&
        hasPlayed &&
        !nearlyDone &&
        phase === 'showtime' &&
        !isIntermission;

      if (!shouldShow) {
        window.LOFNowTiming = null;
        updateNowProgress(null);
        return;
      }

      // Cache timing
      window.LOFNowTiming = {
        duration: duration,
        elapsed: played,
        updatedAt: Date.now()
      };

      updateNowProgress({
        duration: duration,
        elapsed: played
      });

    } catch (e) {
      console.warn('[LOF Viewer] FPP status fetch error:', e);
      window.LOFNowTiming = null;
      updateNowProgress(null);
    }
  }

  /* -------------------------
   * Extra panel (queue / leaderboard / stats / speakers / glow)
   * ------------------------- */

  function renderExtraPanel(mode, enabled, data, queueLength) {
    const extra = document.getElementById('rf-extra-panel');
    if (!extra) return;

    extra.innerHTML = '';

    if (!enabled) {
      extra.innerHTML = `
        <div class="rf-extra-title">Viewer control paused</div>
        <div class="rf-extra-sub">
          When interactive mode is back on, you’ll see the live request queue or top-voted songs here.
        </div>
      `;
    } else if (mode === 'JUKEBOX') {
      renderQueue(extra, data);
    } else if (mode === 'VOTING') {
      renderLeaderboard(extra, data);
    } else {
      extra.innerHTML = `
        <div class="rf-extra-title">Show status</div>
        <div class="rf-extra-sub">
          Interactive controls are on, but this mode doesn’t expose queue or vote data.
        </div>
      `;
    }

    renderStats(extra, queueLength);
    addGlowTeaser(extra);
    addSpeakerCard(extra);

    // Ensure the full Glow form lives in the footer,
    // not in the right-hand extras column.
    const footerGlow = document.getElementById('rf-footer-glow');
    if (footerGlow && !footerGlow.hasChildNodes()) {
      addGlowCard(footerGlow);
    }
  }

  function renderQueue(extra, data) {
    const rawRequests = Array.isArray(data.requests) ? data.requests : [];
    const wrapper = document.createElement('div');
    wrapper.className = 'rf-extra-panel rf-extra-panel--queue';

    const header = document.createElement('div');
    header.innerHTML = `
      <div class="rf-extra-title">Up Next Queue</div>
      <div class="rf-extra-sub">
        Songs requested by guests appear here in the order they’re queued.
      </div>
    `;
    wrapper.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'rf-queue-list';

    if (!rawRequests.length) {
      const empty = document.createElement('div');
      empty.className = 'rf-extra-sub';
      empty.textContent =
        'Requests are handled behind the scenes by Remote Falcon. When your pick is ready, you’ll see it glow as “Next Up.”';
      wrapper.appendChild(list);
      wrapper.appendChild(empty);
      extra.appendChild(wrapper);
      return;
    }

    rawRequests.forEach((item, idx) => {
      if (!item || typeof item !== 'object') return;

      const seq = (item.sequence && typeof item.sequence === 'object') ? item.sequence : {};
      const displayTitle = seq.displayName || seq.name || 'Untitled';
      const artist       = seq.artist || '';
      // Always use the current index as the position so the queue number
      // reflects the live order as songs are played/removed.
      const pos          = idx + 1;

      const li = document.createElement('li');
      li.className = 'rf-queue-item';
      li.innerHTML = `
        <span class="rf-queue-position">#${pos}</span>
        <span class="rf-queue-song">${escapeHtml(displayTitle)}</span>
        ${artist ? `<span class="rf-queue-artist">${escapeHtml(artist)}</span>` : ''}
      `;
      list.appendChild(li);
    });

    wrapper.appendChild(list);
    extra.appendChild(wrapper);
  }

  function renderLeaderboard(extra, data) {
    const rawVotes = Array.isArray(data.votes) ? data.votes : [];
    const wrapper = document.createElement('div');
    wrapper.className = 'rf-extra-panel rf-extra-panel--leaderboard';

    const items = rawVotes
      .map((item) => {
        if (!item || typeof item !== 'object') return null;

        let seqObj = null;
        if (item.sequence && typeof item.sequence === 'object') {
          seqObj = item.sequence;
        } else if (item.sequenceGroup && typeof item.sequenceGroup === 'object') {
          seqObj = item.sequenceGroup;
        }

        if (!seqObj) return null;

        const displayTitle = seqObj.displayName || seqObj.name || 'Untitled';
        const votes        = typeof item.votes === 'number' ? item.votes : 0;

        return {
          name: displayTitle,
          votes
        };
      })
      .filter(Boolean);

    items.sort((a, b) => b.votes - a.votes);
    const top = items.slice(0, 5);

    const header = document.createElement('div');
    header.innerHTML = `
      <div class="rf-extra-title">Top Voted</div>
      <div class="rf-extra-sub">
        Songs with the most votes are most likely to play next.
      </div>
    `;
    wrapper.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'rf-leaderboard-list';

    if (!top.length) {
      const empty = document.createElement('div');
      empty.className = 'rf-extra-sub';
      empty.textContent = 'No votes yet — tap a song to send the first one.';
      wrapper.appendChild(list);
      wrapper.appendChild(empty);
      extra.appendChild(wrapper);
      return;
    }

    top.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'rf-leaderboard-item';
      li.innerHTML = `
        <span class="rf-leaderboard-rank">#${idx + 1}</span>
        <span class="rf-leaderboard-song">${escapeHtml(item.name)}</span>
        <span class="rf-leaderboard-votes">${item.votes} vote${item.votes === 1 ? '' : 's'}</span>
      `;
      list.appendChild(li);
    });

    wrapper.appendChild(list);
    extra.appendChild(wrapper);
  }

  /* -------------------------
   * Stats panel
   * ------------------------- */

  function renderStats(extra, queueLength) {
    const stats = viewerStats || { requests: 0, surprise: 0 };

    const title         = lofCopy('stats_title', 'Tonight from this device');
    const reqLabel      = lofCopy('stats_requests_label', 'Requests sent');
    const surpriseLabel = lofCopy('stats_surprise_label', '“Surprise me” taps');
    const vibeLabel     = lofCopy('stats_vibe_label', 'Falcon vibe check');

    let vibeText = lofCopy('stats_vibe_low', 'Cozy & chill 😌');
    if (queueLength >= 3 && queueLength <= 7) {
      vibeText = lofCopy('stats_vibe_med', 'Party forming 🕺');
    } else if (queueLength > 7) {
      vibeText = lofCopy('stats_vibe_high', 'Full-send Falcon 🔥');
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'rf-stats';

    wrapper.innerHTML = `
      <div class="rf-stats-title">${escapeHtml(title)}</div>
      <div class="rf-stats-row">
        <span>${escapeHtml(reqLabel)}</span>
        <span>${stats.requests}</span>
      </div>
      <div class="rf-stats-row">
        <span>${escapeHtml(surpriseLabel)}</span>
        <span>${stats.surprise}</span>
      </div>
      <div class="rf-stats-row rf-stats-row--vibe">
        <span>${escapeHtml(vibeLabel)}</span>
        <span>${escapeHtml(vibeText)}</span>
      </div>
    `;

    extra.appendChild(wrapper);
  }

  /* -------------------------
   * Glow card
   * ------------------------- */

  function addGlowTeaser(extra) {
    if (!extra) return;

    const title = lofCopy('glow_teaser_title', 'Send a Glow 💛');
    const sub   = lofCopy(
      'glow_teaser_sub',
      'Want to leave a note about your favorite moment tonight? Scroll down to the footer to send a Glow.'
    );

    const wrap = document.createElement('div');
    wrap.className = 'rf-extra-panel rf-extra-panel--glow-teaser';
    wrap.innerHTML = `
      <div class="rf-extra-title">${escapeHtml(title)}</div>
      <div class="rf-extra-sub">${escapeHtml(sub)}</div>
    `;

    extra.appendChild(wrap);
  }

  function addGlowCard(extra) {
    const title       = lofCopy('glow_title', 'Send a little glow 💚');
    const sub         = lofCopy('glow_sub', 'Drop a short note of thanks, joy, or encouragement.');
    const placeholder = lofCopy('glow_placeholder', 'Tell us who made your night, or what made you smile…');
    const namePlaceholder = lofCopy('glow_name_placeholder', 'Name or initials (optional)');
    const btnLabel    = lofCopy('glow_btn', 'Send this glow ✨');

    const card = document.createElement('div');
    card.className = 'rf-glow-card';

    card.innerHTML = `
      <div class="rf-extra-title">${escapeHtml(title)}</div>
      <div class="rf-extra-sub">
        ${escapeHtml(sub)}
      </div>
      <div class="rf-glow-form">
        <textarea class="rf-glow-message" rows="3" placeholder="${escapeHtml(placeholder)}"></textarea>
        <input class="rf-glow-name" type="text" placeholder="${escapeHtml(namePlaceholder)}" />
        <div class="rf-glow-footer">
          <span class="rf-glow-charcount">0 / 280</span>
          <button class="rf-glow-btn">${escapeHtml(btnLabel)}</button>
        </div>
      </div>
    `;

    extra.appendChild(card);

    const messageEl   = card.querySelector('.rf-glow-message');
    const nameEl      = card.querySelector('.rf-glow-name');
    const btnEl       = card.querySelector('.rf-glow-btn');
    const countEl     = card.querySelector('.rf-glow-charcount');

    const minLen = 5;
    const maxLen = 280;
    const glowCooldownMs = 60 * 1000; // 60s between glows from a single device

    if (messageEl && countEl) {
      messageEl.addEventListener('input', () => {
        const len = messageEl.value.length;
        countEl.textContent = `${len} / ${maxLen}`;
      });
    }

    if (!btnEl || !messageEl) return;

    btnEl.addEventListener('click', async () => {
      const now = Date.now();
      const last = getLastGlowTime();

      if (now - last < glowCooldownMs) {
        const msg = lofCopy(
          'glow_rate_limited',
          'You just sent a glow. Give it a minute before sending another.'
        );
        showToast(msg, 'error');
        return;
      }

      const message = (messageEl.value || '').trim();
      const name    = nameEl ? (nameEl.value || '').trim() : '';

      if (message.length < minLen) {
        const msg = lofCopy(
          'glow_too_short',
          'Give us a little more than that. 🙂'
        );
        showToast(msg, 'error');
        return;
      }
      if (message.length > maxLen) {
        const msg = lofCopy(
          'glow_too_long',
          'That\'s a bit too long for a quick glow.'
        );
        showToast(msg, 'error');
        return;
      }

      btnEl.disabled = true;
      const originalLabel = btnEl.textContent;
      btnEl.textContent = 'Sending glow…';

      try {
        const res = await fetch('/wp-json/lof-extras/v1/glow', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            message: message,
            name: name
          })
        });

        const data = await res.json().catch(() => null);

        if (res.ok && data && data.success) {
          saveLastGlowTime(now);
          const msg = lofCopy(
            'glow_success_toast',
            'Glow sent. Thanks for sharing the love. 💚'
          );
          showToast(msg, 'success');
          messageEl.value = '';
          if (nameEl) nameEl.value = '';
          if (countEl) countEl.textContent = `0 / ${maxLen}`;
        } else {
          const msg = lofCopy(
            'glow_error_toast',
            'Could not send glow. Please try again.'
          );
          showToast(msg, 'error');
        }
      } catch (e) {
        const msg = lofCopy(
          'glow_error_toast',
          'Could not send glow. Please try again.'
        );
        showToast(msg, 'error');
      } finally {
        btnEl.disabled = false;
        btnEl.textContent = originalLabel;
      }
    });
  }

/* -------------------------
 * Speaker control card
 * ------------------------- */
function addSpeakerCard(extra) {
  const btnLabelOn = lofCopy('speaker_btn_on', 'Turn speakers on 🔊');
  const timePrefix = lofCopy('speaker_time_left_prefix', 'Time left:');
  const fmLabel = lofCopy('speaker_fm_label', 'FM radio');
  const fmText = lofCopy(
    'speaker_fm_text',
    'Prefer the car stereo? Tune to 88.3 FM near the show.'
  );
  const streamLabel = lofCopy('speaker_stream_label', 'Listen on your phone');

  // TODO: if we later wire this into LOF Extras settings, read from config instead.
  const pulsemeshUrl = 'https://player.pulsemesh.io/d/G073';

  const card = document.createElement('div');
  card.className = 'rf-card rf-speaker-card';

  card.innerHTML = `
    <div class="rf-speaker-card-inner">
      <div class="rf-speaker-header">
        <div class="rf-label">${escapeHtml(lofCopy('speaker_label', 'Need sound?'))}</div>
        <div class="rf-speaker-body">
          ${escapeHtml(
            lofCopy(
              'speaker_intro',
              'Choose how you want to hear the show — outside speakers, on your phone, or in your car.'
            )
          )}
        </div>
      </div>

      <div class="rf-audio-option rf-audio-option--speaker">
        <div class="rf-label">${escapeHtml(
          lofCopy('speaker_outdoor_label', 'Speakers outside')
        )}</div>
        <button
          type="button"
          class="rf-speaker-btn js-speaker-on"
        >
          ${escapeHtml(btnLabelOn)}
        </button>
        <div class="rf-audio-help">
          ${escapeHtml(
            lofCopy(
              'speaker_outdoor_help',
              'For visitors standing near the lights. Speakers switch off automatically after a few minutes so we don’t blast the block all night.'
            )
          )}
        </div>
        <div class="rf-speaker-timer-row">
          <span class="rf-speaker-timer-label">${escapeHtml(timePrefix)}</span>
          <span class="rf-speaker-timer-value lof-speaker-countdown-inline"></span>
        </div>
      </div>

      <div class="rf-audio-option rf-audio-option--stream">
        <div class="rf-label">${escapeHtml(streamLabel)}</div>
        <button
          type="button"
          class="rf-glow-btn js-open-global-stream"
          data-label="${escapeHtml(streamLabel)}"
        >
          ${escapeHtml(streamLabel)} 🎧
        </button>
        <div class="rf-audio-help">
          Opens a small player at the bottom so you can keep exploring the controls.
        </div>
      </div>

      <div class="rf-audio-option rf-audio-option--fm">
        <div class="rf-label">${escapeHtml(fmLabel)}</div>
        <div class="rf-audio-help">
          ${escapeHtml(fmText)}
        </div>
      </div>
    </div>
  `;

  // (stream state restore removed)

  extra.appendChild(card);

  // Updated DOM queries per new markup
  const btn = card.querySelector('.js-speaker-on');
  const statusText = card.querySelector('.rf-speaker-body');
  const countdownEl = card.querySelector('.lof-speaker-countdown-inline');
  const timerRow = card.querySelector('.rf-speaker-timer-row');

  // hide timer row by default
  if (timerRow) timerRow.style.display = 'none';

  // Speaker button is always visible on all widths now

  async function refreshSpeakerStatus() {
    if (!statusText) return;

    try {
      const res = await fetch(
        '/wp-content/themes/integrations/lof-speaker.php?action=status',
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
        }
      );

      const data = await res.json().catch(() => null);
      const msg = (data && typeof data.message === 'string') ? data.message.trim() : '';

      if (res.ok && data && data.success === true && typeof data.speakerOn === 'boolean') {
        const on = data.speakerOn;
        const rem = typeof data.remainingSeconds === 'number'
          ? data.remainingSeconds
          : 0;

        if (on) {
          // Speaker ON
          const statusOnText = lofCopy(
            'speaker_status_on',
            'Speakers are currently ON near the show.'
          );

          const baseText = msg || statusOnText;

          if (rem > 0) {
            const minutes = Math.ceil(rem / 60);
            const label = minutes <= 1
              ? 'about 1 minute'
              : `about ${minutes} minutes`;

            statusText.textContent = baseText;
            if (countdownEl) countdownEl.textContent = label;
            if (timerRow) timerRow.style.display = 'flex';
          } else {
            statusText.textContent = baseText;
            if (countdownEl) countdownEl.textContent = '';
            if (timerRow) timerRow.style.display = 'none';
          }
        } else {
          // Speaker OFF
          const statusOffText = lofCopy(
            'speaker_status_off',
            'Speakers are off by default. If you’re standing at the show, you can turn them on for a bit.'
          );

          statusText.textContent = msg || statusOffText;
          if (countdownEl) countdownEl.textContent = '';
          if (timerRow) timerRow.style.display = 'none';
        }
      } else if (msg) {
        statusText.textContent = msg;
        if (countdownEl) countdownEl.textContent = '';
        if (timerRow) timerRow.style.display = 'none';
      } else {
        statusText.textContent = lofCopy(
          'speaker_status_unknown',
          'Unable to read speaker status.'
        );
        if (countdownEl) countdownEl.textContent = '';
        if (timerRow) timerRow.style.display = 'none';
      }
    } catch (e) {
      statusText.textContent = lofCopy(
        'speaker_status_unknown',
        'Unable to reach show controller.'
      );
      if (countdownEl) countdownEl.textContent = '';
      if (timerRow) timerRow.style.display = 'none';
    }
  }

  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const oldText = btn.textContent;
      btn.textContent = 'Talking to the show…';

      try {
        const res = await fetch(
          '/wp-content/themes/integrations/lof-speaker.php?action=on',
          {
            method: 'POST',
            headers: { Accept: 'application/json' },
          }
        );

        const data = await res.json().catch(() => null);

        if (res.ok && data && data.success) {
          showToast('Speakers should be on now. ', 'success');
        } else {
          const errorText = lofCopy(
            'speaker_error_msg',
            'Something glitched while talking to the speakers.'
          );
          const msg = (data && data.message) ? data.message : errorText;
          showToast(msg, 'error');
        }
      } catch (e) {
        const errorText = lofCopy(
          'speaker_error_msg',
          'Something glitched while talking to the speakers.'
        );
        showToast(errorText, 'error');
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = oldText;
          refreshSpeakerStatus();
        }, 1500);
      }
    });
  }

  // Initial status fetch and shared polling loop
  try {
    refreshSpeakerStatus();
    if (typeof window !== 'undefined') {
      if (!window.LOF_SPEAKER_POLL) {
        window.LOF_SPEAKER_POLL = setInterval(refreshSpeakerStatus, 15000);
      }
    }
  } catch (e) {
    // Non-fatal; card will show default copy
  }
}

// Global click handler for stream player (lazy iframe and toggle on persistent footer)
document.addEventListener('click', function (e) {
  const btn = e.target.closest('.js-open-global-stream');
  if (!btn) return;

  const footer = document.getElementById('lof-stream-footer');
  if (!footer) {
    console.warn('[LOF Viewer] Global stream footer not found.');
    return;
  }

  const originalLabel = btn.getAttribute('data-label') || 'Listen on your phone';

  // First time: create the iframe on demand
  if (!lofStreamState.init) {
    const src = footer.getAttribute('data-src');
    if (!src) {
      console.warn('[LOF Viewer] No stream URL configured on lof-stream-footer.');
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.title = 'Lights on Falcon live stream';
    iframe.loading = 'lazy';
    iframe.className = 'rf-audio-iframe';
    iframe.allow = 'autoplay'; // safe because user clicked to create it

    footer.appendChild(iframe);
    lofStreamState.init = true;
  }

  // Toggle visibility without destroying the iframe
  lofStreamState.visible = !lofStreamState.visible;
  footer.classList.toggle('rf-stream-footer--visible', lofStreamState.visible);

  btn.textContent = lofStreamState.visible
    ? 'Hide stream player'
    : originalLabel + ' 🎧';
});


  /* -------------------------
   * Surprise Me card
   * ------------------------- */

  function addSurpriseCard() {
    if (!gridEl) return;
    if (!currentControlEnabled) return;
    if (!currentVisibleSequences || !currentVisibleSequences.length) return;

    const card = document.createElement('div');
    card.className = 'rf-card rf-card--surprise';

    const title    = lofCopy('surprise_title', 'Can’t pick just one?');
    const subtitle = lofCopy('surprise_sub', 'Let us queue up a random crowd-pleaser for you.');
    const btnText  = lofCopy('surprise_btn', 'Surprise me ✨');

    card.innerHTML = `
      <div class="rf-card-title">${escapeHtml(title)}</div>
      <div class="rf-card-artist">
        ${escapeHtml(subtitle)}
      </div>
      <div class="rf-card-meta">
        <span class="rf-card-duration">We’ll choose from tonight’s available songs.</span>
      </div>
      <div class="rf-card-actions">
        <button class="rf-card-btn">
          ${escapeHtml(btnText)}
        </button>
      </div>
    `;

    const btn = card.querySelector('.rf-card-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        handleSurpriseMe();
      });
    }

    gridEl.appendChild(card);
  }

  /* -------------------------
   * Actions (request / vote)
   * ------------------------- */

  function getButtonLabel(mode, controlEnabled) {
    if (!controlEnabled) return 'Viewer control disabled';
    if (mode === 'JUKEBOX') return 'Request this song';
    if (mode === 'VOTING')  return 'Vote for this song';
    return 'Request';
  }

  function formatModeLabel(mode, enabled) {
    const prettyMode = mode || 'UNKNOWN';
    const status = enabled ? 'viewer control ON' : 'viewer control OFF';
    return `${prettyMode} (${status})`;
  }

  async function handleAction(mode, seq, btn) {
    if (!base) return;
  // Hard guard: if viewer control is disabled, do not send any actions.
    if (!currentControlEnabled) {
      const msg = lofCopy(
        'viewer_action_disabled',
        'Viewer control is currently paused. You can still enjoy the show!'
      );
      showToast(msg, 'error');
      return;
    }
    
    const endpoint = (mode === 'VOTING') ? '/vote' : '/request';
    const sequenceKey = seq.name;
    const now = Date.now();

    // Global per-device cooldown to avoid hammering RF with rapid-fire actions
    if (lastGlobalActionTime && now - lastGlobalActionTime < GLOBAL_ACTION_COOLDOWN) {
      const remainingGlobal = Math.ceil((GLOBAL_ACTION_COOLDOWN - (now - lastGlobalActionTime)) / 1000);
      showToast(`Easy there, DJ. Wait ${remainingGlobal}s before sending another action.`, 'error');
      return;
    }

    // Per-song cooldown to prevent spamming the same track
    if (lastActionTimes[sequenceKey] && now - lastActionTimes[sequenceKey] < ACTION_COOLDOWN) {
      const remaining = Math.ceil((ACTION_COOLDOWN - (now - lastActionTimes[sequenceKey])) / 1000);
      showToast(`Please wait ${remaining}s before interacting with this song again.`, 'error');
      return;
    }

    // Enforce optional request limit for JUKEBOX mode.
    // This is OFF by default unless explicitly enabled via LOF Extras / RF prefs
    // with an `enforceRequestLimit` flag set to true.
    if (
      mode === 'JUKEBOX' &&
      currentPrefs &&
      currentPrefs.enforceRequestLimit === true &&
      typeof currentPrefs.jukeboxRequestLimit === 'number'
    ) {
      const limit = currentPrefs.jukeboxRequestLimit;
      if (limit > 0 && viewerStats && typeof viewerStats.requests === 'number' && viewerStats.requests >= limit) {
        const msg = lofCopy(
          'jukebox_limit_reached_toast',
          'You’ve hit the request limit for this visit. You can still enjoy the show!'
        );
        showToast(msg, 'error');
        return;
      }
    }

    lastGlobalActionTime = now;
    lastActionTimes[sequenceKey] = now;

    if (btn) {
      btn.disabled = true;
      btn.textContent = (mode === 'VOTING') ? 'Sending vote…' : 'Sending request…';
    }

    const payload = {
      sequence: seq.name
    };

    try {
      const res = await fetch(base + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => null);

      if (res.ok) {
        const codeMessage = data && data.message ? ` (${data.message})` : '';
        const msg = (mode === 'VOTING')
          ? `Vote sent! You’re helping pick the next song.${codeMessage}`
          : `Request sent! You’re in the queue.${codeMessage}`;
        showToast(msg, 'success');

        if (mode === 'JUKEBOX') {
          lastRequestedSequenceName = seq.name || seq.displayName || null;
          if (lastRequestedSequenceName &&
              requestedSongNames.indexOf(lastRequestedSequenceName) === -1) {
            requestedSongNames.push(lastRequestedSequenceName);
            saveRequestedSongs();
          }
          viewerStats.requests += 1;
          saveStats();
        }
      } else {
        const errMsg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
        showToast('Remote Falcon issue: ' + errMsg, 'error');
      }

      fetchShowDetails();
    } catch (err) {
      console.error('[RF] Action error:', err);
      showToast('Network issue—please try again.', 'error');
    } finally {
      setTimeout(() => {
        if (btn) {
          btn.disabled = false;
          btn.textContent = getButtonLabel(mode, true);
        }
      }, 1000);
    }
  }

  /* -------------------------
   * Surprise Me
   * ------------------------- */

  function handleSurpriseMe() {
    if (!currentControlEnabled) {
      const disabledMsg = lofCopy('surprise_disabled', 'Viewer control is currently paused.');
      showToast(disabledMsg, 'error');
      return;
    }

    if (!currentVisibleSequences.length) {
      showToast('No songs available right now.', 'error');
      return;
    }

    // Base pool: songs visible & active
    const basePool = currentVisibleSequences.slice();

    // Prefer songs the visitor has NOT already requested this session
    const unrequesedPool = basePool.filter((seq) => {
      const key = seq.name || seq.displayName;
      if (!key) return false;
      return !requestedSongNames.includes(key);
    });

    // Start from unrequesed songs if we have any, otherwise all visible songs
    let candidateBase = unrequesedPool.length ? unrequesedPool : basePool;

    // Avoid immediately repeating the currently-playing song
    candidateBase = candidateBase.filter((seq) => {
      const key = seq.name || seq.displayName;
      if (!key) return false;
      if (currentNowKey && key === currentNowKey) return false;
      return true;
    });

    // If that wiped everything out, fall back to the original basePool
    if (!candidateBase.length) {
      candidateBase = basePool;
    }

    // Prefer songs that are NOT already in the live RF queue
    const noQueuePool = candidateBase.filter((seq) => {
      const key = seq.name || seq.displayName;
      if (!key) return false;
      return !currentQueueCounts[key];
    });

    let candidateList = noQueuePool.length ? noQueuePool : candidateBase;

    if (!candidateList.length) {
      showToast('No songs available right now.', 'error');
      return;
    }

    // Prefer songs that this device hasn't heard much tonight.
    let minPlay = Infinity;
    candidateList.forEach((seq) => {
      const key = seq.name || seq.displayName;
      const c = key ? getPlayedCount(key) : 0;
      if (c < minPlay) minPlay = c;
    });

    // Keep songs within a small band of the least-played to avoid always picking the same one
    const lowPlayedPool = candidateList.filter((seq) => {
      const key = seq.name || seq.displayName;
      const c = key ? getPlayedCount(key) : 0;
      return c <= minPlay + 1;
    });

    const finalList = lowPlayedPool.length ? lowPlayedPool : candidateList;

    viewerStats.surprise += 1;
    saveStats();

    if (viewerStats.surprise === 4) {
      const fourthMsg = lofCopy(
        'surprise_fourth_time',
        'You like chaos. We respect that. 😈'
      );
      showToast(fourthMsg, 'success');
    }

    const randomIndex = Math.floor(Math.random() * finalList.length);
    const seq = finalList[randomIndex];

    handleAction(currentMode, seq, null);
  }

  /* -------------------------
   * Utils
   * ------------------------- */

  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* -------------------------
   * Init
   * ------------------------- */

  // LOF Extras config + Remote Falcon data in parallel
  lofLoadConfig();
  fetchShowDetails();
  setInterval(fetchShowDetails, 15000);

  // FPP timing (for Now Playing progress bar)
  fetchFppStatus();
  setInterval(fetchFppStatus, 5000);
  setInterval(tickNowProgress, 1000);
})();