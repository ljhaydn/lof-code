(function () {
  const base = (window.RFViewer && RFViewer.base) ? RFViewer.base : '';
  
  console.log('[LOF viewer] rf-viewer.js loaded');
  
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

// V1.5: Stream + wake lock tracking
let wakeLock = null;
let wakeLockEnabled = false;

// V1.5: Adaptive polling tracking
let lastInteractionTime = Date.now();
const ADAPTIVE_POLL_TIMEOUT = 120000; // 2 minutes idle → slow polling
const POLL_INTERVAL_ACTIVE = 3000; // 3s when active
const POLL_INTERVAL_IDLE = 15000; // 15s when idle

// V1.5: Speaker protection tracking
let speakerProtectionActive = false;
let lastSpeakerCheckTime = 0;
let currentFppSongKey = null;

// True when FPP + RF agree that a real song is playing (SHOWTIME phase)
let isSongPlayingNow = false;

// V1.5: Geo check tracking
let geoCheckPerformed = false;
let userConfirmedLocal = false;

// V1.5: Polling interval tracking
let currentPollInterval = null;

// V1.5: Speaker status polling + countdown (for more "real-time" speaker timer)
let speakerStatusPollTimer = null;
let speakerCountdownTimer = null;
let speakerCountdownState = null; // { remainingBase, updatedAt }

  // -----------------------------
  // LOF EXTRAS CONFIG
  // -----------------------------
  const LOFViewer = {
    config: null,
    configLoaded: false
  };

  // Default PulseMesh stream URL (can be overridden by LOF Extras config)
  const LOF_STREAM_URL_DEFAULT = 'https://player.pulsemesh.io/d/G073';

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

  // V1.5: Update hero CTA from config
function updateHeroCTA() {
  const headlineEl = document.getElementById('rf-hero-headline');
  const subcopyEl = document.getElementById('rf-hero-subcopy');
  
  if (!headlineEl || !subcopyEl) return;
  
  const config = getLofConfig();
  if (!config || !config.copy) {
    // Defaults if no config
    headlineEl.textContent = 'Tap a song to request it 🎧';
    subcopyEl.textContent = 'Requests join the queue in the order they come in. You can request multiple songs each session while the queue is open.';
    return;
  }
  
  const headline = config.copy.hero_headline || 'Tap a song to request it 🎧';
  const subtext = config.copy.hero_subtext || 'Requests join the queue in the order they come in. You can request multiple songs each session while the queue is open.';
  
  headlineEl.textContent = headline;
  subcopyEl.textContent = subtext;
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
let lastExtraSignature = null;

// V1.5: Track user interactions for adaptive polling
function trackUserActivity() {
  lastInteractionTime = Date.now();
  adjustPollingInterval();
}

// V1.5: Adaptive polling interval adjustment
function adjustPollingInterval() {
  const now = Date.now();
  const timeSinceLastAction = now - lastInteractionTime;
  
  let desiredInterval;
  if (timeSinceLastAction < ADAPTIVE_POLL_TIMEOUT) {
    desiredInterval = POLL_INTERVAL_ACTIVE;
  } else {
    desiredInterval = POLL_INTERVAL_IDLE;
  }
  
  // Only change if different
  if (currentPollInterval !== desiredInterval) {
    currentPollInterval = desiredInterval;
    console.log(`[LOF V1.5] Poll interval changed to: ${desiredInterval}ms`);
    
    // Clear old interval and start new one
    if (window.LOF_MAIN_POLL_INTERVAL) {
      clearInterval(window.LOF_MAIN_POLL_INTERVAL);
    }
    window.LOF_MAIN_POLL_INTERVAL = setInterval(fetchShowDetails, desiredInterval);
  }
}

// Set up activity listeners
if (typeof document !== 'undefined') {
  document.addEventListener('click', trackUserActivity, { passive: true });
  document.addEventListener('touchstart', trackUserActivity, { passive: true });
  document.addEventListener('keydown', trackUserActivity, { passive: true });

  // If the tab becomes visible again and the user asked to keep the screen awake,
  // try to re-acquire the wake lock.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeLockEnabled) {
      acquireWakeLockIfNeeded();
    }
  });
}

// Global guardrails
let lastGlobalActionTime = 0;
const GLOBAL_ACTION_COOLDOWN = 5000; // 5s between any actions from this device

  // Local “identity” for this device
  const STORAGE_REQUESTS_KEY   = 'lofRequestedSongs_v1';
  const STORAGE_STATS_KEY      = 'lofViewerStats_v1';
  const STORAGE_GLOW_KEY       = 'lofGlowLastTime_v1';
  const STORAGE_GLOW_TOTAL_KEY = 'lofGlowLastTotal_v1';
  const STORAGE_PLAYED_KEY     = 'lofPlayedCounts_v1';
  const STORAGE_WAKE_LOCK_KEY  = 'lofKeepAwakeEnabled_v1';

  let requestedSongNames = loadRequestedSongs();
  let viewerStats        = loadStats();
  let playedCounts       = loadPlayedCounts();

  // Wake lock preference (persisted)
  try {
    wakeLockEnabled = window.localStorage.getItem(STORAGE_WAKE_LOCK_KEY) === 'true';
  } catch (e) {
    wakeLockEnabled = false;
  }

  // last requested song (name) this session
  let lastRequestedSequenceName = null;
  // cache last phase for banner logic
  let lastPhase = 'idle';
// V1.5: Screen Wake Lock helpers (to reduce mobile audio interruptions)
async function acquireWakeLockIfNeeded() {
  if (!wakeLockEnabled) return;
  if (typeof navigator === 'undefined' || !navigator.wakeLock) return;

  try {
    // If we already hold a lock, do nothing
    if (wakeLock) return;

    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (err) {
    console.warn('[LOF V1.5] Wake lock request failed:', err);
    wakeLock = null;
  }
}

function releaseWakeLock() {
  try {
    if (wakeLock && typeof wakeLock.release === 'function') {
      wakeLock.release();
    }
  } catch (e) {
    // ignore
  } finally {
    wakeLock = null;
  }
}

  /* -------------------------
   * Local storage helpers
   * ------------------------- */

  function loadRequestedSongs() {
    try {
      const raw = window.localStorage.getItem(STORAGE_REQUESTS_KEY);
      if (!raw) return [];
      const val = JSON.parse(raw);
      if (!Array.isArray(val)) return [];
      // Deduplicate to keep lookups clean
      return Array.from(
        new Set(
          val.filter((x) => typeof x === 'string' && x.trim() !== '')
        )
      );
    } catch (e) {
      return [];
    }
  }

  function saveRequestedSongs() {
    try {
      window.localStorage.setItem(STORAGE_REQUESTS_KEY, JSON.stringify(requestedSongNames));
    } catch (e) {}
  }

    function addRequestedSongName(name) {
    if (!name) return;
    if (!Array.isArray(requestedSongNames)) {
      requestedSongNames = [];
    }
    if (!requestedSongNames.includes(name)) {
      requestedSongNames.push(name);
      saveRequestedSongs();
    }
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
  // Ensure correct array shape
  if (!Array.isArray(requestedSongNames)) {
    requestedSongNames = [];
    saveRequestedSongs();
    return;
  }

  // Deduplicate
  const unique = Array.from(
    new Set(
      requestedSongNames.filter((x) => typeof x === 'string' && x.trim() !== '')
    )
  );

  requestedSongNames = unique;

  // Build a set of active keys: now-playing + queue entries
  const active = new Set();

  if (nowSeq) {
    if (nowSeq.name && typeof nowSeq.name === 'string') {
      active.add(nowSeq.name);
    }
    if (nowSeq.displayName && typeof nowSeq.displayName === 'string') {
      active.add(nowSeq.displayName);
    }
  }

  if (Array.isArray(queue)) {
    queue.forEach((item) => {
      if (!item || !item.sequence) return;
      const seq = item.sequence;
      if (!seq || typeof seq !== 'object') return;

      if (seq.name && typeof seq.name === 'string') {
        active.add(seq.name);
      }
      if (seq.displayName && typeof seq.displayName === 'string') {
        active.add(seq.displayName);
      }
    });
  }

  // If RF hasn’t reported any active songs or queue entries yet, do not clear
  // stored requests based on this snapshot. This avoids dropping the very
  // first pick during intermission or right as a new song is starting.
  if (active.size === 0) {
    return;
  }

  // Only remove requests that are fully inactive
  const filtered = requestedSongNames.filter((name) => active.has(name));

  if (filtered.length !== requestedSongNames.length) {
    requestedSongNames = filtered;
    saveRequestedSongs();
  }
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

  function getLastGlowTotal() {
    try {
      const raw = window.localStorage.getItem(STORAGE_GLOW_TOTAL_KEY);
      if (!raw) return 0;
      const n = parseInt(raw, 10);
      return isNaN(n) ? 0 : n;
    } catch (e) {
      return 0;
    }
  }

  function saveLastGlowTotal(total) {
    try {
      const n = parseInt(total, 10);
      if (isNaN(n) || n < 0) return;
      window.localStorage.setItem(STORAGE_GLOW_TOTAL_KEY, String(n));
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

  // V1.5: Perform geo check using Cloudflare headers + browser geolocation
async function performGeoCheck() {
  if (geoCheckPerformed || userConfirmedLocal) return;
  
  const config = getLofConfig();
  if (!config || !config.geoCheckEnabled) return;

  // We now know we have a real config and geo is enabled, so we can
  // safely mark the check as performed for this page load.
  geoCheckPerformed = true;
  
  let distance = null;
  let city = null;
  
  // Try Cloudflare headers first
  if (config.cloudflare && config.cloudflare.city) {
    city = config.cloudflare.city;
    
    // Calculate distance using Haversine if we have coordinates
    if (config.cloudflare.latitude && config.cloudflare.longitude) {
      const showLat = config.showLatitude || 0;
      const showLon = config.showLongitude || 0;
      distance = calculateDistance(
        config.cloudflare.latitude,
        config.cloudflare.longitude,
        showLat,
        showLon
      );
    }
  }
  
  // Fallback: Try browser geolocation if permission already granted
  if (distance === null && typeof navigator !== 'undefined' && navigator.permissions) {
    try {
      const permission = await navigator.permissions.query({ name: 'geolocation' });
      if (permission.state === 'granted' && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const showLat = config.showLatitude || 0;
            const showLon = config.showLongitude || 0;
            distance = calculateDistance(
              position.coords.latitude,
              position.coords.longitude,
              showLat,
              showLon
            );
            showGeoMessage(distance, city);
          },
          () => {
            // Failed - show fallback
            showGeoMessage(null, city);
          },
          { timeout: 5000, maximumAge: 300000 }
        );
        return; // Wait for callback
      }
    } catch (e) {
      // Permissions API not supported
    }
  }
  
  // Show message with what we have
  showGeoMessage(distance, city);
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  // Haversine formula
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function showGeoMessage(distance, city) {
  const extra = document.getElementById('rf-extra-panel');
  if (!extra) return;

  const card = document.createElement('div');
  card.className = 'rf-card rf-card--geo';

  let noticeClass, message;

  if (distance !== null && distance < 5) {
    // Local visitor – automatically grant full access
    noticeClass = 'rf-geo-notice--local';
    const cityText = city ? ` You're in ${city}!` : '';
    message = lofCopy('geo_local_message', `Welcome neighbor!${cityText} 🎄`);

    userConfirmedLocal = true;
    try {
      localStorage.setItem('lofUserConfirmedLocal', 'true');
    } catch (e) {}
  } else if (distance !== null && distance >= 5) {
    // Far visitor – show "I'm here" button so they can self-confirm
    noticeClass = 'rf-geo-notice--far';
    message = lofCopy('geo_far_message', 'Visiting from afar? Come see the show in person! 🌟');

    const confirmBtnText = lofCopy('geo_confirm_btn', 'I\'m here - full access');

    card.innerHTML = `
      <div class="rf-geo-notice ${noticeClass}">
        <div class="rf-geo-message">${escapeHtml(message)}</div>
        <button class="rf-geo-confirm-btn" onclick="window.lofConfirmLocal()">
          ${escapeHtml(confirmBtnText)}
        </button>
      </div>
    `;
    extra.prepend(card);
    return;
  } else {
    // Fallback – no reliable distance; err on the side of granting access
    noticeClass = 'rf-geo-notice--fallback';
    message = lofCopy(
      'geo_fallback_message',
      'Location services unavailable - full access granted'
    );

    userConfirmedLocal = true;
    try {
      localStorage.setItem('lofUserConfirmedLocal', 'true');
    } catch (e) {}
  }

  card.innerHTML = `
    <div class="rf-geo-notice ${noticeClass}">
      <div class="rf-geo-message">${escapeHtml(message)}</div>
    </div>
  `;

  extra.prepend(card);
}

// Global function for "I'm here" button
window.lofConfirmLocal = function() {
  userConfirmedLocal = true;
  try {
    localStorage.setItem('lofUserConfirmedLocal', 'true');
  } catch (e) {}
  const geoCard = document.querySelector('.rf-card--geo');
  if (geoCard) geoCard.remove();
  showToast(lofCopy('geo_confirmed_toast', 'Welcome! Full access granted 🎄'), 'success');
};

// Check localStorage on load
try {
  if (localStorage.getItem('lofUserConfirmedLocal') === 'true') {
    userConfirmedLocal = true;
  }
} catch (e) {}

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

function updateBanner(phase, enabled) {
  const banner = document.getElementById('rf-viewer-banner');
  const titleEl = document.getElementById('rf-banner-title');
  const bodyEl = document.getElementById('rf-banner-body');
  
  if (!banner || !titleEl || !bodyEl) return;
  
  const config = getLofConfig();
  
  // Manual override: offseason always wins
  if (config && config.holiday_mode === 'offseason') {
    banner.style.display = 'block';
    banner.className = 'rf-viewer-banner rf-banner--offseason';
    titleEl.textContent = lofCopy('banner_offseason_title', 'We\'re resting up for next season');
    bodyEl.textContent = lofCopy('banner_offseason_body', 'Check back soon for more glowing chaos.');
    return;
  }

  // Derive show state from schedule + RF phase
  const showState = getShowState(phase);

  if (showState === 'showtime') {
    banner.style.display = 'block';
    banner.className = 'rf-viewer-banner rf-banner--showtime';
    titleEl.textContent = lofCopy('banner_showtime_title', 'Showtime 🎶');
    bodyEl.textContent = lofCopy('banner_showtime_body', 'Lights, audio, and neighbors in sync.');
    return;
  }

  if (showState === 'intermission') {
    banner.style.display = 'block';
    banner.className = 'rf-viewer-banner rf-banner--intermission';
    titleEl.textContent = lofCopy('banner_intermission_title', 'Intermission');
    bodyEl.textContent = lofCopy('banner_intermission_body', 'The lights are catching their breath between songs.');
    return;
  }

  if (showState === 'afterhours') {
    banner.style.display = 'block';
    banner.className = 'rf-viewer-banner rf-banner--afterhours';
    titleEl.textContent = lofCopy('banner_afterhours_title', 'We’re taking a breather');
    bodyEl.textContent = lofCopy('banner_afterhours_body', 'The lights are resting until the next show.');
    return;
  }

  // Fallback: hide the banner if we don't have a clear state
  banner.style.display = 'none';
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
        queueCount: queueLength
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

      // Generic fairness message that doesn&apos;t rely on RF&apos;s per-sequence limit
      parts.push(
        lofCopy(
          'header_jukebox_fair',
          'You can request songs from this device while the queue is open. If the queue gets extra long, we may pause new requests so everyone gets a turn.'
        )
      );

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

    // Use internal name as the key, but friendly displayName as the label
    const nowKeyName = nowSeq ? (nowSeq.name || nowSeq.displayName) : null;
    const nowLabel   = nowSeq ? (nowSeq.displayName || nowSeq.name || '') : '';

    if (nowKeyName && requestedSongNames.includes(nowKeyName)) {
      nowMatches.push(nowLabel || nowKeyName);
    }

    if (Array.isArray(queue)) {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        if (!item || typeof item !== 'object') continue;

        const seq   = item.sequence || {};
        const key   = seq.name || seq.displayName;              // internal key for matching
        const label = seq.displayName || seq.name || '';        // friendly title for display

        if (!key) continue;
        if (requestedSongNames.includes(key)) {
          // Use the current index + 1 so the position tracks live queue order,
          // even if RF's stored "position" is not updated as the queue drains.
          const pos = i + 1;
          queueMatches.push({ name: label || key, pos });
        }
      }
    }

    let text = '';
    const hasNowMatches = nowMatches.length > 0;
    const hasQueueMatches = queueMatches.length > 0;

    if (hasNowMatches || hasQueueMatches) {
      const parts = [];

      if (hasNowMatches) {
        if (nowMatches.length === 1) {
          parts.push(`Your request “${nowMatches[0]}” is playing right now. Enjoy the glow ✨`);
        } else {
          parts.push(`One of your picks is playing now! (${nowMatches.join(', ')})`);
        }
      }

      if (hasQueueMatches) {
        if (queueMatches.length === 1) {
          const item = queueMatches[0];
          const queueText = `Your song “${item.name}” is currently #${item.pos} in the queue.`;
          parts.push(hasNowMatches ? queueText.replace(/^Your/, 'Plus your') : queueText);
        } else {
          const queueParts = queueMatches
            .sort((a, b) => a.pos - b.pos)
            .map((x) => `“${x.name}” (#${x.pos})`);
          const queueText = `Your picks are moving up: ${queueParts.join(', ')}`;
          parts.push(hasNowMatches ? queueText.replace(/^Your/, 'Plus your') : queueText);
        }
      }

      text = parts.join(' ');
    } else {
      text = 'Your previous requests have played. Pick another to keep the show moving. 🎶';
    }

    el.textContent = text;
    el.style.display = 'block';

    // Keep requested chips synced
    syncRequestedSongsWithStatus(nowSeq, queue);
  }

    // V1.5: Simple mobile detection for stream behavior
  function lofIsLikelyMobile() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /iPhone|iPad|iPod|Android/i.test(ua);
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

  // Helper to parse mm:ss or hh:mm:ss time strings (e.g., "2:34" or "1:02:03")
  function lofParseTimeString(str) {
    if (typeof str !== 'string') return NaN;
    const parts = str.split(':');
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      const s = parseInt(parts[1], 10);
      if (isNaN(m) || isNaN(s)) return NaN;
      return m * 60 + s;
    }
    if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const s = parseInt(parts[2], 10);
      if (isNaN(h) || isNaN(m) || isNaN(s)) return NaN;
      return h * 3600 + m * 60 + s;
    }
    return NaN;
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
        document.getElementById('rf-footer-glow') ||
        document.querySelector('.rf-glow-card') ||
        document.querySelector('.rf-tonight');
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

    // Prefer explicit sequence objects from RF when available, but still
    // support older payloads that only send name/displayName strings.
    const playingNowRaw  = data.playingNow || '';
    const playingNextRaw = data.playingNext || '';
    const playingNextFromSchedule = data.playingNextFromSchedule || '';

    const playingNowSequence =
      data.playingNowSequence && typeof data.playingNowSequence === 'object'
        ? data.playingNowSequence
        : null;

    const playingNextSequence =
      data.playingNextSequence && typeof data.playingNextSequence === 'object'
        ? data.playingNextSequence
        : null;

    ensureHeader();
    ensureMainLayout();
    ensureBanner();

    // NOW PLAYING
    let nowSeq = null;
    if (playingNowSequence) {
      nowSeq = playingNowSequence;
    } else {
      nowSeq =
        sequences.find(
          (s) => s.name === playingNowRaw || s.displayName === playingNowRaw
        ) || null;
    }

    // NEXT UP
    let nextSeq = null;

    // 1) Trust RF's explicit next sequence object when present
    if (playingNextSequence) {
      nextSeq = playingNextSequence;
    }

    // 2) Fall back to matching playingNext / playingNextFromSchedule against the sequence list
    if (!nextSeq) {
      const nextRawCombined = playingNextRaw || playingNextFromSchedule || '';
      if (nextRawCombined) {
        nextSeq =
          sequences.find(
            (s) =>
              s.name === nextRawCombined || s.displayName === nextRawCombined
          ) || null;
      }
    }

    // 3) Finally, fall back to the first queued request if we still don't have a next sequence
    if (!nextSeq && rawRequests.length > 0 && rawRequests[0].sequence) {
      nextSeq = rawRequests[0].sequence;
    }

    const nowDisplay = nowSeq
      ? (nowSeq.displayName || nowSeq.name || playingNowRaw)
      : (playingNowRaw || 'Nothing currently playing');

    const nextDisplayRaw = playingNextRaw || playingNextFromSchedule || '';

    const nextDisplay = nextSeq
      ? (nextSeq.displayName || nextSeq.name || nextDisplayRaw)
      : (nextDisplayRaw || '—');

    const nowArtist = nowSeq && nowSeq.artist ? nowSeq.artist : '';

    const nowKey  = nowSeq  ? (nowSeq.name  || nowSeq.displayName) : playingNowRaw;
    const nextKey = nextSeq ? (nextSeq.name || nextSeq.displayName) : nextDisplayRaw;
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
    updateBanner(phase, currentControlEnabled);
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

      const keyName = seq.name || '';
      const labelName = seq.displayName || '';

      // Check the persistent requested list first
      const wasRequested = (
        (keyName && requestedSongNames.includes(keyName)) ||
        (labelName && requestedSongNames.includes(labelName))
      );

      // Safety net: if this is the currently playing song and it matches
      // the last requested sequence name this session, always show the
      // "Your pick is playing" chip even if local request tracking has
      // already been trimmed by sync logic.
      let showRequestedChip = wasRequested;
      if (!showRequestedChip && isNow && lastRequestedSequenceName) {
        if (
          keyName === lastRequestedSequenceName ||
          labelName === lastRequestedSequenceName
        ) {
          showRequestedChip = true;
        }
      }

      if (showRequestedChip) {
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
      if (btn) {
        if (!currentControlEnabled) {
          // RF says viewer control is off – keep the button visually disabled
          btn.disabled = true;
        } else {
          btn.disabled = false;
          btn.addEventListener('click', () => {
            // Optional LOF-side geofence: if enabled and the visitor has not
            // confirmed they are local, block the request with a friendly toast.
            const config = getLofConfig();
            if (config && config.geoCheckEnabled && !userConfirmedLocal) {
              const msg = lofCopy(
                'geo_request_blocked',
                'Song requests are reserved for guests at the show. If you’re here in person, tap “I’m here - full access” above and try again.'
              );
              showToast(msg, 'error');
              return;
            }

            handleAction(currentMode, seq, btn);
          });
        }
      }

      gridEl.appendChild(card);
    });

  addSurpriseCard();

  // Only re-render extras when something meaningful changes
  const extraSignature = JSON.stringify({
    mode: currentMode,
    enabled: currentControlEnabled,
    queueLen: queueLength,
    votesLen: Array.isArray(rawVotes) ? rawVotes.length : 0,
    requests: viewerStats ? viewerStats.requests : 0,
    surprise: viewerStats ? viewerStats.surprise : 0
  });

  if (extraSignature !== lastExtraSignature) {
    lastExtraSignature = extraSignature;
    renderExtraPanel(currentMode, currentControlEnabled, data, queueLength);
  }
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
      const rawStatus = (data && typeof data.raw === 'object') ? data.raw : {};

      // Prefer per-song timing from the LOF mini endpoint if available.
      // We explicitly favor the nested "raw" values for current song over the
      // top-level playlist seconds_remaining (which can be hours long).
      let songPlayedRaw =
        data.song_seconds_played ??
        data.current_song_seconds_played ??
        data.sequence_seconds_played ??
        rawStatus.seconds_played ??
        rawStatus.seconds_elapsed ??
        data.seconds_played ??
        data.seconds_elapsed;

      let songRemainingRaw =
        data.song_seconds_remaining ??
        data.current_song_seconds_remaining ??
        data.sequence_seconds_remaining ??
        rawStatus.seconds_remaining ??
        null;

      // If we still don't have a remaining seconds value, try parsing time strings
      if (songRemainingRaw == null && typeof rawStatus.time_remaining === 'string') {
        const parsed = lofParseTimeString(rawStatus.time_remaining);
        if (!isNaN(parsed)) {
          songRemainingRaw = parsed;
        }
      }
      if (songRemainingRaw == null && typeof data.time_remaining === 'string') {
        const parsed = lofParseTimeString(data.time_remaining);
        if (!isNaN(parsed)) {
          songRemainingRaw = parsed;
        }
      }

      const songDurationRaw =
        data.song_duration ??
        data.current_song_duration ??
        data.sequence_duration ??
        null;

      const played    = parseInt(songPlayedRaw, 10);
      const remaining = parseInt(songRemainingRaw, 10);
      const playlist  = String(data.playlist_name || '').toLowerCase();

      const hasPlayed    = !isNaN(played);
      const hasRemaining = !isNaN(remaining);

      let duration = null;

      if (songDurationRaw != null && !isNaN(parseInt(songDurationRaw, 10))) {
        duration = parseInt(songDurationRaw, 10);
      } else if (hasPlayed && hasRemaining) {
        duration = played + remaining;
      }

      // If we don't have sane per-song timing, don't show the bar.
      if (!duration || duration <= 1 || !hasPlayed) {
        window.LOFNowTiming = null;
        updateNowProgress(null);
        return;
      }

      const phase = lastPhase || 'idle';

      // Show the bar only when RF/FPP report "playing" AND the viewer is in SHOWTIME phase.
      const shouldShow =
        statusName === 'playing' &&
        phase === 'showtime';

      // Track whether a real song is playing for speaker protection logic
      isSongPlayingNow = shouldShow;

      if (!shouldShow) {
        window.LOFNowTiming = null;
        updateNowProgress(null);
        // When playback stops or we're not in SHOWTIME, re-evaluate speaker protection
        checkSpeakerProtection();
        return;
      }

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

// V1.5: Check speaker protection during FPP playback
async function checkSpeakerProtection() {
  const config = getLofConfig();
  const endpoint =
    (config && typeof config.speakerEndpoint === 'string' && config.speakerEndpoint.trim() !== '')
      ? config.speakerEndpoint.trim()
      : '/wp-content/themes/integrations/lof-speaker.php';

  if (!endpoint) return;

  try {
    const res = await fetch(endpoint + '?action=status', {
      credentials: 'same-origin'
    });

    if (!res.ok) return;
    const data = await res.json();

    // If we can't read a boolean speakerOn flag, bail without flipping UI state
    if (!data || typeof data.speakerOn !== 'boolean') {
      return;
    }

    if (!data.speakerOn) {
      // Speakers are off: protection is not active
      speakerProtectionActive = false;
      updateSpeakerCardProtection();
      return;
    }

    // Speakers are ON – protection is active only while a real song is playing
    speakerProtectionActive = !!isSongPlayingNow;
    updateSpeakerCardProtection();
  } catch (err) {
    console.warn('[LOF V1.5] Speaker protection check failed:', err);
  }
}

function updateSpeakerCardProtection() {
  const offBtn = document.querySelector('.js-speaker-off');
  if (!offBtn) return;
  
  if (speakerProtectionActive) {
    offBtn.disabled = true;
    offBtn.textContent = lofCopy('speaker_protection_active', '🔒 Protected during song');
  } else {
    offBtn.disabled = false;
    offBtn.textContent = lofCopy('speaker_btn_off', 'Turn speakers off');
  }
}

  /* -------------------------
   * Extra panel (queue / leaderboard / stats / speakers / glow)
   * ------------------------- */

  // V1.5: Fetch and display trigger counts
async function fetchTriggerCounts() {
  try {
    const res = await fetch('/wp-json/lof-viewer/v1/trigger-counts', {
      credentials: 'same-origin'
    });
    
    if (!res.ok) return null;
    const data = await res.json();
    
    if (data && data.success && data.counts) {
      return data.counts;
    }
    return null;
  } catch (err) {
    console.warn('[LOF V1.5] Trigger counts fetch failed:', err);
    return null;
  }
}

  function renderExtraPanel(mode, enabled, data, queueLength) {
  const extra = document.getElementById('rf-extra-panel');
  if (!extra) return;

  extra.innerHTML = '';
  
  // V1.5: Perform geo check on first render
  if (!geoCheckPerformed && !userConfirmedLocal) {
    performGeoCheck();
  }

  if (!enabled) {
    extra.innerHTML = `
      <div class="rf-extra-title">Viewer control paused</div>
      <div class="rf-extra-sub">
        When interactive mode is back on, you'll see the live request queue or top-voted songs here.
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
        Interactive controls are on, but this mode doesn't expose queue or vote data.
      </div>
    `;
  }

  // Render device stats card with trigger counts
  renderDeviceStatsCard(extra, queueLength);

  // IMPORTANT: Do NOT add the in-panel Glow teaser anymore.
  // The full Glow form lives in the footer only, so viewers have a single,
  // consistent place to send a Glow.
  // (Intentionally no call to addGlowTeaser(extra) here.)

  // Speaker / "Need sound?" card lives at the bottom of the extras panel
  addSpeakerCard(extra);

  // Ensure the full Glow form lives in the footer
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

  // No requests – keep the card compact with a single explanatory line
  if (!rawRequests.length) {
    const empty = document.createElement('div');
    empty.className = 'rf-extra-sub';
    empty.textContent =
      'Requests are handled behind the scenes by Remote Falcon. When your pick is ready, you’ll see it glow as “Next Up.”';
    wrapper.appendChild(empty);
    extra.appendChild(wrapper);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'rf-queue-list';

  rawRequests.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;

    const seq = (item.sequence && typeof item.sequence === 'object') ? item.sequence : {};
    const displayTitle = seq.displayName || seq.name || 'Untitled';
    const artist       = seq.artist || '';
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

// V1.5: Render device stats as ornament card with trigger counts + vibe
function renderDeviceStatsCard(extra, queueLength) {
  const stats = viewerStats || { requests: 0, surprise: 0 };

  // Persona / vibe line
  const vibeLabel = lofCopy('stats_vibe_label', 'Falcon vibe check');
  let vibeText = lofCopy('stats_vibe_low', 'Cozy & chill 😌');
  if (queueLength >= 3 && queueLength <= 7) {
    vibeText = lofCopy('stats_vibe_med', 'Party forming 🕺');
  } else if (queueLength > 7) {
    vibeText = lofCopy('stats_vibe_high', 'Full-send Falcon 🔥');
  }

  const card = document.createElement('div');
  card.className = 'rf-card rf-card--device-stats';

  card.innerHTML = `
    <div class="rf-device-stats-title">
      ${escapeHtml(lofCopy('device_stats_title', 'Tonight From This Device'))}
    </div>
    <div class="rf-device-stats-body">
      <div class="rf-stat-item">
        <span class="rf-stat-label">${escapeHtml(lofCopy('stats_requests_label', 'Requests sent'))}</span>
        <span class="rf-stat-value">${stats.requests}</span>
      </div>
      <div class="rf-stat-item">
        <span class="rf-stat-label">${escapeHtml(lofCopy('stats_surprise_label', '"Surprise me" taps'))}</span>
        <span class="rf-stat-value">${stats.surprise}</span>
      </div>
      <div class="rf-stat-item rf-stat-item--vibe">
        <span class="rf-stat-label">${escapeHtml(vibeLabel)}</span>
        <span class="rf-stat-value">${escapeHtml(vibeText)}</span>
      </div>
    </div>
  `;

  extra.appendChild(card);

  // Lazy-load Mischief Meter counts and enhance the card in-place
  fetchTriggerCounts()
    .then((triggers) => {
      if (!triggers) return;

      const body = card.querySelector('.rf-device-stats-body');
      if (!body) return;

      const divider = document.createElement('div');
      divider.className = 'rf-stat-divider';
      body.appendChild(divider);

      const sectionLabel = document.createElement('div');
      sectionLabel.className = 'rf-stat-section-label';
      sectionLabel.textContent = lofCopy('trigger_overall_label', 'Tonight’s Mischief Meter');
      body.appendChild(sectionLabel);

      if (typeof triggers.mailbox !== 'undefined') {
        // New padding logic: start at 32, then add rawMailbox + (rawMailbox * 1.5)
        const rawMailbox =
          typeof triggers.mailbox === 'number'
            ? triggers.mailbox
            : parseInt(triggers.mailbox, 10) || 0;

        const boostedMailbox =
          rawMailbox >= 0
            ? 32 + rawMailbox + Math.round(rawMailbox * 1.5)
            : 32;

        const row = document.createElement('div');
        row.className = 'rf-stat-item rf-stats-row--mischief';
        row.innerHTML = `
          <span class="rf-stat-label">
            ${escapeHtml(lofCopy('trigger_santa_label', '🎅 Letters to Santa:'))}
          </span>
          <span class="rf-stat-value">${boostedMailbox}</span>
        `;
        body.appendChild(row);
      }

      // --- Begin Glow block ---
      {
        let rawGlow = 0;

        if (triggers && Object.prototype.hasOwnProperty.call(triggers, 'glow')) {
          rawGlow =
            typeof triggers.glow === 'number'
              ? triggers.glow
              : parseInt(triggers.glow, 10) || 0;
        }

        // If the trigger API doesn't yet expose a glow count (or it's zero),
        // fall back to the last known nightly total we received from the
        // Glow endpoint on this device.
        if (rawGlow <= 0) {
          try {
            const storedTotal = getLastGlowTotal();
            if (storedTotal > 0) {
              rawGlow = storedTotal;
            }
          } catch (e) {
            // ignore; we'll just use baseline padding
          }
        }

        // Light FOMO padding: start at 3, then add rawGlow + (rawGlow * 1.25)
        // This keeps the real count directionally honest but makes the meter
        // feel a bit more alive even on lighter nights.
        const boostedGlow =
          rawGlow >= 0
            ? 3 + rawGlow + Math.round(rawGlow * 1.25)
            : 3;

        const row = document.createElement('div');
        row.className =
          'rf-stat-item rf-stats-row--mischief rf-stats-row--glow';
        row.innerHTML = `
          <span class="rf-stat-label">
            ${escapeHtml(lofCopy('trigger_glow_label', '💚 Glows sent:'))}
          </span>
          <span class="rf-stat-value">${boostedGlow}</span>
        `;
        body.appendChild(row);
      }
      // --- End Glow block ---

      if (typeof triggers.button !== 'undefined') {
        const row = document.createElement('div');
        row.className = 'rf-stat-item rf-stats-row--mischief';
        row.innerHTML = `
          <span class="rf-stat-label">
            ${escapeHtml(lofCopy('trigger_button_label', '🔴 Naughty or Nice Checks:'))}
          </span>
          <span class="rf-stat-value">${triggers.button}</span>
        `;
        body.appendChild(row);
      }

            if (typeof triggers.surprise !== 'undefined') {
        const rawSurprise =
          typeof triggers.surprise === 'number'
            ? triggers.surprise
            : parseInt(triggers.surprise, 10) || 0;

        const row = document.createElement('div');
        row.className =
          'rf-stat-item rf-stats-row--mischief rf-stats-row--surprise';
        row.innerHTML = `
          <span class="rf-stat-label">
            ${escapeHtml(lofCopy('trigger_surprise_label', '🎁 Surprise songs launched:'))}
          </span>
          <span class="rf-stat-value">${rawSurprise}</span>
        `;
        body.appendChild(row);
      }
    })
    .catch((err) => {
      console.warn('[LOF V1.5] Trigger counts update failed:', err);
    });
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

        const isOk =
          res.ok &&
          data &&
          (data.status === 'ok' ||
            data.status === 'OK' ||
            data.success === true);

        if (isOk) {
          saveLastGlowTime(now);
          const msg = lofCopy(
            'glow_success_toast',
            'Glow sent. Thanks for sharing the love. 💚'
          );
          showToast(msg, 'success');
          messageEl.value = '';
          if (nameEl) nameEl.value = '';
          if (countEl) countEl.textContent = `0 / ${maxLen}`;

          // Update the Mischief Meter "Glows sent" row using the latest total
          // from the backend so the number feels live right after sending,
          // and persist that total locally so refreshes on this device stay
          // in sync with tonight's glow count.
          try {
            const rawTotal =
              data && typeof data.total === 'number'
                ? data.total
                : null;
            if (rawTotal !== null && rawTotal >= 0) {
              // Persist last known nightly total for future loads
              saveLastGlowTotal(rawTotal);

              const boostedGlow =
                3 + rawTotal + Math.round(rawTotal * 1.25);

              const glowValueEl = document.querySelector(
                '.rf-stats-row--glow .rf-stat-value'
              );
              if (glowValueEl) {
                glowValueEl.textContent = String(boostedGlow);
              }
            }
          } catch (updateErr) {
            // If anything goes wrong updating the UI, fail silently and keep
            // the success toast; this is purely an enhancement.
          }
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
    'Prefer the car stereo? Tune to 107.7 FM near the show.'
  );
  const streamLabel = lofCopy('speaker_stream_label', 'Listen on your phone');

  // Use the default PulseMesh URL (can be overridden via footer data-src)
  const pulsemeshUrl = LOF_STREAM_URL_DEFAULT || 'https://player.pulsemesh.io/d/G073';

  const card = document.createElement('div');
  card.className = 'rf-card rf-speaker-card rf-card--speaker'; // V1.5: Add --speaker class

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
          On some phones, you may need to tap the play button in the bar and keep this page open to continue listening.
        </div>
      </div>

      <div class="rf-audio-option rf-audio-option--keep-awake" style="display:none;">
        <!-- keep-awake temporarily hidden -->
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

  // Clear any previous timers when the speaker card is re-rendered
  if (speakerStatusPollTimer) {
    clearTimeout(speakerStatusPollTimer);
    speakerStatusPollTimer = null;
  }
  if (speakerCountdownTimer) {
    clearInterval(speakerCountdownTimer);
    speakerCountdownTimer = null;
  }
  speakerCountdownState = null;

  // Ensure the global stream footer knows which URL to use
  (function ensureStreamFooterDataSrc() {
    const footer =
      document.getElementById('lof-stream-footer') ||
      document.getElementById('rf-stream-footer');
    if (!footer) return;

    if (!footer.getAttribute('data-src')) {
      const config = getLofConfig();
      const configuredUrl =
        config &&
        config.stream &&
        typeof config.stream.url === 'string' &&
        config.stream.url.trim() !== ''
          ? config.stream.url.trim()
          : null;

      const src = configuredUrl || LOF_STREAM_URL_DEFAULT;
      footer.setAttribute('data-src', src);
    }
  })();

  // Updated DOM queries per new markup
  const btn = card.querySelector('.js-speaker-on');
  const statusText = card.querySelector('.rf-speaker-body');
  const countdownEl = card.querySelector('.lof-speaker-countdown-inline');
  const timerRow = card.querySelector('.rf-speaker-timer-row');

  // hide timer row by default
  if (timerRow) timerRow.style.display = 'none';

  // Speaker button is always visible on all widths now

  // Kick off initial speaker status + protection checks so the UI is accurate on first render
  // (moved here, after statusText is defined)
  refreshSpeakerStatus();
  checkSpeakerProtection();

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

          statusText.textContent = baseText;

          // Update the button label when speakers are active
          if (btn) {
            const activeLabel = lofCopy(
              'speaker_btn_on_active',
              'Speakers are ON 🔊'
            );
            btn.textContent = activeLabel;
          }

          if (rem > 0) {
            if (countdownEl) countdownEl.textContent = lofFormatTime(rem);
            if (timerRow) timerRow.style.display = 'flex';

            // Start or update the smooth countdown state
            const nowMs = Date.now();
            if (!speakerCountdownState) {
              speakerCountdownState = {
                remainingBase: rem,
                updatedAt: nowMs
              };
            } else {
              speakerCountdownState.remainingBase = rem;
              speakerCountdownState.updatedAt = nowMs;
            }

            if (!speakerCountdownTimer && countdownEl) {
              speakerCountdownTimer = setInterval(() => {
                if (!speakerCountdownState || !countdownEl) return;

                const now = Date.now();
                const elapsedSec = Math.max(
                  0,
                  (now - speakerCountdownState.updatedAt) / 1000
                );
                const remaining = Math.max(
                  0,
                  Math.round(speakerCountdownState.remainingBase - elapsedSec)
                );

                if (remaining <= 0) {
                  countdownEl.textContent = '';
                  if (timerRow) timerRow.style.display = 'none';
                  clearInterval(speakerCountdownTimer);
                  speakerCountdownTimer = null;
                  // When countdown reaches zero, pull a fresh status so the
                  // button label and state reflect speakers turning OFF.
                  refreshSpeakerStatus();
                  return;
                }

                countdownEl.textContent = lofFormatTime(remaining);
              }, 1000);
            }
          } else {
            // ON but no remainingSeconds reported
            if (countdownEl) countdownEl.textContent = '';
            if (timerRow) timerRow.style.display = 'none';
            speakerCountdownState = null;
            if (speakerCountdownTimer) {
              clearInterval(speakerCountdownTimer);
              speakerCountdownTimer = null;
            }
          }

          // While speakers are ON, periodically refresh from backend so mid-song
          // extensions are reflected in the UI.
          if (speakerStatusPollTimer) {
            clearTimeout(speakerStatusPollTimer);
          }
          speakerStatusPollTimer = setTimeout(() => {
            refreshSpeakerStatus();
          }, 20000); // re-sync every 20s while ON
        } else {
          // Speaker OFF
          const statusOffText = lofCopy(
            'speaker_status_off',
            'Speakers are off by default. If you’re standing at the show, you can turn them on for a bit.'
          );

          statusText.textContent = msg || statusOffText;
          if (countdownEl) countdownEl.textContent = '';
          if (timerRow) timerRow.style.display = 'none';

          // Reset countdown + polling when OFF
          speakerCountdownState = null;
          if (speakerCountdownTimer) {
            clearInterval(speakerCountdownTimer);
            speakerCountdownTimer = null;
          }
          if (speakerStatusPollTimer) {
            clearTimeout(speakerStatusPollTimer);
            speakerStatusPollTimer = null;
          }

          // Restore the default button label when speakers are off
          if (btn) {
            btn.textContent = btnLabelOn;
          }
        }
      } else if (msg) {
        statusText.textContent = msg;
        if (countdownEl) countdownEl.textContent = '';
        if (timerRow) timerRow.style.display = 'none';
        // On unknown/partial responses, stop any active timers
        speakerCountdownState = null;
        if (speakerCountdownTimer) {
          clearInterval(speakerCountdownTimer);
          speakerCountdownTimer = null;
        }
        if (speakerStatusPollTimer) {
          clearTimeout(speakerStatusPollTimer);
          speakerStatusPollTimer = null;
        }
      } else {
        statusText.textContent = lofCopy(
          'speaker_status_unknown',
          'Unable to read speaker status.'
        );
        if (countdownEl) countdownEl.textContent = '';
        if (timerRow) timerRow.style.display = 'none';
        // On unknown/partial responses, stop any active timers
        speakerCountdownState = null;
        if (speakerCountdownTimer) {
          clearInterval(speakerCountdownTimer);
          speakerCountdownTimer = null;
        }
        if (speakerStatusPollTimer) {
          clearTimeout(speakerStatusPollTimer);
          speakerStatusPollTimer = null;
        }
      }
    } catch (e) {
      statusText.textContent = lofCopy(
        'speaker_status_unknown',
        'Unable to reach show controller.'
      );
      if (countdownEl) countdownEl.textContent = '';
      if (timerRow) timerRow.style.display = 'none';
      // On errors, stop any active timers
      speakerCountdownState = null;
      if (speakerCountdownTimer) {
        clearInterval(speakerCountdownTimer);
        speakerCountdownTimer = null;
      }
      if (speakerStatusPollTimer) {
        clearTimeout(speakerStatusPollTimer);
        speakerStatusPollTimer = null;
      }
    }
  }

  if (btn) {
    btn.addEventListener('click', async () => {
      // Hard guard: never allow speakers to be turned on while RF/FPP report intermission.
      // This uses the same phase logic that drives the viewer banner and dimming.
      if (lastPhase === 'intermission') {
        const msg = lofCopy(
          'speaker_intermission_blocked',
          'Speakers only come on during show songs so intermission stays a little quieter.'
        );
        showToast(msg, 'error');
        return;
      }

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

  const streamBtn = card.querySelector('.js-open-global-stream');
  if (streamBtn) {
    streamBtn.addEventListener('click', () => {
      const footer =
        document.getElementById('lof-stream-footer') ||
        document.getElementById('rf-stream-footer');
      if (!footer) return;

      const footerSrc = footer.getAttribute('data-src');
      const streamUrl = footerSrc || pulsemeshUrl;

      if (lofStreamState.visible) {
        // Stop embedded stream (desktop case)
        footer.classList.remove('active');
        footer.classList.remove('rf-stream-footer--visible');

        // Remove the iframe so the PulseMesh player actually stops audio
        const existingIframe = footer.querySelector('.rf-audio-iframe');
        if (existingIframe && existingIframe.parentNode) {
          existingIframe.parentNode.removeChild(existingIframe);
        }
        lofStreamState.init = false;
        lofStreamState.visible = false;

        const startLabel = lofCopy('stream_btn_start', 'Listen on your phone');
        streamBtn.textContent = startLabel + ' 🎧';

        // When the stream bar is hidden, release any wake lock we were holding
        releaseWakeLock();
        return;
      }

      // MOBILE — open PulseMesh in a new tab so the tap counts as a gesture
      if (lofIsLikelyMobile()) {
        try {
          window.open(streamUrl, '_blank', 'noopener');
        } catch (e) {
          // Fallback if popups are blocked: navigate this tab
          window.location.href = streamUrl;
        }
        return;
      }

      // DESKTOP — embed PulseMesh in the bottom footer
      if (!lofStreamState.init) {
        const iframe = document.createElement('iframe');
        iframe.src = streamUrl;
        iframe.allow = 'autoplay';
        iframe.className = 'rf-audio-iframe';
        footer.appendChild(iframe);
        lofStreamState.init = true;
      }

      footer.classList.add('active');
      footer.classList.add('rf-stream-footer--visible');

      const stopLabel = lofCopy('stream_btn_stop', 'Hide stream');
      streamBtn.textContent = stopLabel;
      lofStreamState.visible = true;

      // If the user opted to keep the screen awake, try to acquire a wake lock
      if (wakeLockEnabled) {
        acquireWakeLockIfNeeded();
      }
    });

    // Restore label on re-render based on current stream state
    if (lofStreamState.visible) {
      const stopLabel = lofCopy('stream_btn_stop', 'Hide stream');
      streamBtn.textContent = stopLabel;
    } else {
      const startLabel = lofCopy('stream_btn_start', 'Listen on your phone');
      streamBtn.textContent = startLabel + ' 🎧';
    }
  }

  const keepAwakeToggle = card.querySelector('.rf-keep-awake-toggle');
  if (keepAwakeToggle) {
    // Initialize from persisted preference
    keepAwakeToggle.checked = !!wakeLockEnabled;

    keepAwakeToggle.addEventListener('change', () => {
      wakeLockEnabled = !!keepAwakeToggle.checked;
      try {
        window.localStorage.setItem(
          STORAGE_WAKE_LOCK_KEY,
          wakeLockEnabled ? 'true' : 'false'
        );
      } catch (e) {}

      if (wakeLockEnabled && lofStreamState.visible) {
        // Only hold a wake lock while the PulseMesh bar is visible
        acquireWakeLockIfNeeded();
      } else if (!wakeLockEnabled) {
        releaseWakeLock();
      }
    });

    // If the user previously enabled keep-awake and the stream footer is already visible,
    // attempt to acquire the wake lock on first render.
    if (keepAwakeToggle.checked && lofStreamState.visible) {
      acquireWakeLockIfNeeded();
    }
  }
}




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
        const keyName = seq.name || '';
        const labelName = seq.displayName || '';

        lastRequestedSequenceName = keyName || labelName || null;

        // Track both internal key and friendly label so chips stay in sync
        if (keyName) {
          addRequestedSongName(keyName);
        }
        if (labelName && labelName !== keyName) {
          addRequestedSongName(labelName);
        }

        if (viewerStats && typeof viewerStats.requests === 'number') {
          viewerStats.requests += 1;
        } else {
          viewerStats = viewerStats || {};
          viewerStats.requests = 1;
        }
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

  // V1.5: Smart exclusion logic
  let pool = currentVisibleSequences.slice();
  
  // Exclude currently playing
  if (currentNowKey) {
    pool = pool.filter(seq => {
      const key = seq.name || seq.displayName;
      return key !== currentNowKey;
    });
  }
  
  // Exclude top of queue
  if (currentQueueCounts && Object.keys(currentQueueCounts).length > 0) {
    pool = pool.filter(seq => {
      const key = seq.name || seq.displayName;
      return !currentQueueCounts[key];
    });
  }
  
  // Exclude last requested this session
  if (lastRequestedSequenceName) {
    pool = pool.filter(seq => {
      const key = seq.name || seq.displayName;
      return key !== lastRequestedSequenceName;
    });
  }
  
  // If all excluded, use original pool
  if (!pool.length) {
    pool = currentVisibleSequences.slice();
  }
  
  // Prefer unrequested songs
  const unrequested = pool.filter(seq => {
    const key = seq.name || seq.displayName;
    return !requestedSongNames.includes(key);
  });
  
  if (unrequested.length) {
    pool = unrequested;
  }
  
  // Prefer least-played songs
  let minPlay = Infinity;
  pool.forEach(seq => {
    const key = seq.name || seq.displayName;
    const c = key ? getPlayedCount(key) : 0;
    if (c < minPlay) minPlay = c;
  });
  
  const lowPlayed = pool.filter(seq => {
    const key = seq.name || seq.displayName;
    const c = key ? getPlayedCount(key) : 0;
    return c <= minPlay + 1;
  });
  
  const finalPool = lowPlayed.length ? lowPlayed : pool;
  
  viewerStats.surprise += 1;
  saveStats();

  if (viewerStats.surprise === 4) {
    const fourthMsg = lofCopy(
      'surprise_fourth_time',
      'You like chaos. We respect that. 😈'
    );
    showToast(fourthMsg, 'success');
  }

  const randomIndex = Math.floor(Math.random() * finalPool.length);
  const seq = finalPool[randomIndex];

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

// LOF Extras config
lofLoadConfig();

// V1.5: Set initial poll interval
currentPollInterval = POLL_INTERVAL_ACTIVE;

// V1.5: Adaptive polling - start with active interval
fetchShowDetails();
window.LOF_MAIN_POLL_INTERVAL = setInterval(fetchShowDetails, POLL_INTERVAL_ACTIVE);

// Check polling adjustment every 30s
setInterval(adjustPollingInterval, 30000);

// FPP timing (for Now Playing progress bar + speaker protection)
fetchFppStatus();
setInterval(fetchFppStatus, 5000);
setInterval(tickNowProgress, 1000);

// V1.5: Speaker protection check every 3s
setInterval(checkSpeakerProtection, 3000);

})();