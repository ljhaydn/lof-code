(function () {
  const base = (window.RFViewer && RFViewer.base) ? RFViewer.base : '';
  
  console.log('[LOF viewer] rf-viewer.js V1.5.0 loaded');
  
  const viewerRoot  = document.getElementById('rf-viewer');
  const gridEl      = document.getElementById('rf-grid');

  // V1.5: Updated element refs - support both old and new hero structures
  const heroEl        = document.getElementById('rf-hero') || document.querySelector('.rf-hero');
  const nowCardEl     = document.getElementById('rf-now') || document.querySelector('.rf-now');
  const nowTitleEl    = document.getElementById('rf-now-title');
  const nowArtistEl   = document.getElementById('rf-now-artist');
  const nextTitleEl   = document.getElementById('rf-next-title');
  const modeEl        = document.getElementById('rf-mode-value');
  
  // V1.5: New hero elements (may be null if using old PHP)
  const heroBannerEl      = document.getElementById('rf-hero-banner');
  const heroBannerTitleEl = document.getElementById('rf-hero-banner-title');
  const heroBannerBodyEl  = document.getElementById('rf-hero-banner-body');
  const heroTimeEl        = document.getElementById('rf-hero-time');
  const heroCtaEl         = document.getElementById('rf-hero-cta');
  const heroCtaTitleEl    = document.getElementById('rf-hero-cta-title');
  const heroCtaBodyEl     = document.getElementById('rf-hero-cta-body');
  const heroMyStatusEl    = document.getElementById('rf-hero-mystatus');
  const heroGeoEl         = document.getElementById('rf-hero-geo');
  
  // Legacy refs for backward compatibility
  const statusPanel = heroEl || document.querySelector('.rf-status-panel');

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

// V1.5: Unified viewer state from /wp-json/lof/v1/viewer-state
// Contains derived state (isLockout, isIntermission, waitSeconds, etc.)
let viewerState = null;

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

// V1.5: Current computed show state
let currentShowState = 'offhours';

// V1.5: Category ordering - categories not in this list appear alphabetically at the end
const CATEGORY_ORDER = [
  'New Tonight',
  'New This Week', 
  'Traditional',
  'Disney',
  'Modern Pop',
  'Rock & Alternative',
  'Country',
  'Classic Rock',
  'Kids & Family',
  'Instrumental',
  'Novelty'
];

// V1.5: Track active category filter (mobile tabs)
let activeCategoryFilter = null;

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

  // V1.5 FIX: Track ALL requested song names this session (not just the last one)
  // This prevents the "Your pick is playing" badge from disappearing when making additional requests
  const sessionRequestedNames = new Set();
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
  async function performGeoCheck(extra) {
    const config = getLofConfig();
    if (!config || !config.geoCheckEnabled) return;

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
                        showGeoMessage(distance, city, extra);
          },
          () => {
            // Failed - show fallback
            showGeoMessage(null, city, extra);
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
  showGeoMessage(distance, city, extra);
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

function showGeoMessage(distance, city, extra) {
  // V1.5 Bundle B: Update hero geo line first
  updateHeroGeo(distance, city);
  
  // If we have the hero geo element, skip the card in extra panel
  if (heroGeoEl) {
    return;
  }
  
  if (!extra) {
    extra = document.getElementById('rf-extra-panel');
  }
  if (!extra) return;

  // Always keep exactly one geo card
  const existing = extra.querySelector('.rf-card--geo');
  if (existing) {
    existing.remove();
  }

  const card = document.createElement('div');
  card.className = 'rf-card rf-card--geo';

  let noticeClass, message;

  if (distance !== null && distance < 5) {
    // Local visitor – automatically grant full access
    noticeClass = 'rf-geo-notice--local';
    // V1.5 Bundle B: Don't show city name - Cloudflare city is too broad (metro area)
    message = lofCopy('geo_local_message', 'Welcome neighbor! 🎄');

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

  // V1.5 Bundle B: Update hero geo line
  if (heroGeoEl) {
    heroGeoEl.innerHTML = '<span class="rf-hero-geo-local">📍 Welcome neighbor! 🎄</span>';
  }

  // Also update extra panel geo card if it exists (backward compat)
  const geoCard = document.querySelector('.rf-card--geo');
  if (geoCard) {
    const notice = geoCard.querySelector('.rf-geo-notice');
    if (notice) {
      notice.classList.remove('rf-geo-notice--far', 'rf-geo-notice--fallback');
      notice.classList.add('rf-geo-notice--local');
    }

    const msgEl = geoCard.querySelector('.rf-geo-message');
    if (msgEl) {
      msgEl.textContent = lofCopy(
        'geo_local_message',
        'Welcome neighbor! 🎄'
      );
    }

    const btn = geoCard.querySelector('.rf-geo-confirm-btn');
    if (btn) {
      btn.remove();
    }
  }

  showToast(
    lofCopy('geo_confirmed_toast', 'Welcome! Full access granted 🎄'),
    'success'
  );
};

// Check localStorage on load
try {
  if (localStorage.getItem('lofUserConfirmedLocal') === 'true') {
    userConfirmedLocal = true;
  }
} catch (e) {}

/**
 * V1.5 Bundle B: Update hero geo status line
 * Shows inline geo status in the hero instead of a separate card
 */
function updateHeroGeo(distance, city) {
  if (!heroGeoEl) return;
  
  const config = getLofConfig();
  if (!config || !config.geoCheckEnabled) {
    heroGeoEl.innerHTML = '';
    return;
  }
  
  // If user already confirmed, show welcome (no city - too inaccurate)
  if (userConfirmedLocal) {
    heroGeoEl.innerHTML = '<span class="rf-hero-geo-local">📍 Welcome neighbor! 🎄</span>';
    return;
  }
  
  if (distance !== null && distance < 5) {
    // Local visitor – automatically grant full access (no city - too inaccurate)
    heroGeoEl.innerHTML = '<span class="rf-hero-geo-local">📍 Welcome neighbor! 🎄</span>';
    userConfirmedLocal = true;
    try {
      localStorage.setItem('lofUserConfirmedLocal', 'true');
    } catch (e) {}
  } else if (distance !== null && distance >= 5) {
    // Far visitor – show unlock link
    heroGeoEl.innerHTML = '📍 Near the display? <span class="rf-hero-geo-link" onclick="window.lofConfirmLocal()">Tap to unlock full access</span>';
  } else {
    // No distance data – still show unlock option
    heroGeoEl.innerHTML = '📍 At the show? <span class="rf-hero-geo-link" onclick="window.lofConfirmLocal()">Tap to unlock requests</span>';
  }
}

  /* -------------------------
   * Fetch showDetails via WP proxy
   * ------------------------- */

  async function fetchShowDetails() {
    // V1.5 FIX: Use unified endpoint as PRIMARY source (includes RF + FPP + derived state)
    // This fixes the race condition where viewerState was null during render
    try {
      const res = await fetch('/wp-json/lof/v1/viewer-state', {
        method: 'GET',
        credentials: 'same-origin'
      });
      
      if (res.ok) {
        const data = await res.json();
        viewerState = data; // Store BEFORE rendering - fixes race condition
        console.log('[LOF] Unified state loaded:', viewerState?.state?.mode, 
                    'lockout:', viewerState?.state?.isLockout,
                    'requests.allowed:', viewerState?.requests?.allowed);
        renderShowDetails(data);
        return;
      } else {
        console.warn('[LOF] Unified endpoint returned:', res.status, '- falling back to RF');
      }
    } catch (err) {
      console.warn('[LOF] Unified endpoint failed:', err.message, '- falling back to RF');
    }
    
    // Fallback to direct RF endpoint if unified fails
    await fetchShowDetailsFallback();
  }
  
  // V1.5: Fallback to direct RF endpoint
  async function fetchShowDetailsFallback() {
    if (!base) return;

    try {
      const res = await fetch(base + '/showDetails');
      if (!res.ok) {
        console.error('[RF] showDetails error:', res.status);
        return;
      }

      const data = await res.json();
      viewerState = null; // No enhanced state in fallback mode
      renderShowDetails(data);
    } catch (err) {
      console.error('[RF] showDetails fetch error:', err);
    }
  }

  /* -------------------------
   * Header + Layout helpers
   * ------------------------- */

  // V1.5: Hero shell - create wrapper if using old PHP structure
  function ensureHeroShell() {
    // If new structure exists, use it
    if (document.getElementById('rf-hero')) {
      return document.getElementById('rf-hero');
    }
    
    // Old structure: create shell around status-panel
    if (!viewerRoot) return null;
    const oldStatusPanel = document.querySelector('.rf-status-panel');
    if (!oldStatusPanel) return null;

    let shell = document.getElementById('lof-hero-shell');
    if (!shell) {
      shell = document.createElement('div');
      shell.id = 'lof-hero-shell';
      shell.className = 'lof-hero-shell';

      if (oldStatusPanel.parentNode === viewerRoot) {
        viewerRoot.insertBefore(shell, oldStatusPanel);
        shell.appendChild(oldStatusPanel);
      } else {
        viewerRoot.insertBefore(shell, viewerRoot.firstChild);
      }
    }

    return shell;
  }

  // V1.5: Header elements - create if using old PHP structure
  function ensureHeader() {
    // If new structure exists, nothing to create
    if (document.getElementById('rf-hero-cta')) {
      return;
    }
    
    if (!viewerRoot) return;

    const shell = ensureHeroShell();
    if (!shell) return;

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

      header.appendChild(headline);
      header.appendChild(subcopy);
      header.appendChild(myStatus);

      const oldStatusPanel = shell.querySelector('.rf-status-panel');
      if (oldStatusPanel) {
        shell.insertBefore(header, oldStatusPanel);
      } else {
        shell.appendChild(header);
      }
    }
  }

  // V1.5: Banner - create if using old PHP structure  
  function ensureBanner() {
    // If new structure exists, nothing to create
    if (document.getElementById('rf-hero-banner')) {
      return;
    }
    
    if (!viewerRoot) return;

    const shell = ensureHeroShell();
    if (!shell) return;

    let banner = document.getElementById('rf-viewer-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'rf-viewer-banner';
      banner.className = 'rf-viewer-banner';
      banner.style.padding = '0.75rem 1rem';
      banner.style.marginBottom = '0.5rem';
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

      const header = document.getElementById('rf-viewer-header');
      if (header && header.parentNode === shell) {
        shell.insertBefore(banner, header);
      } else {
        shell.insertBefore(banner, shell.firstChild);
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
      if (phase === 'showtime') return 'showtime';

      // Inside a scheduled show window but RF/FPP report idle:
      // treat this as an intermission / warmup period instead of full showtime.
      return 'intermission';
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

/**
 * V1.5: Comprehensive show state machine
 * Returns one of: 'preshow', 'showtime', 'intermission', 'paused', 'offhours', 'offline'
 * 
 * @param {Object} options
 * @param {boolean} options.viewerControlEnabled - RF viewerControlEnabled flag
 * @param {string} options.playingNow - Current song name (raw)
 * @param {string} options.fppStatus - FPP status_name ('playing', 'idle', etc.)
 * @param {Object} options.schedule - FPP schedule data (optional)
 * @returns {string} Show state identifier
 */
function computeShowState(options) {
  const {
    viewerControlEnabled = false,
    playingNow = '',
    fppStatus = 'idle',
    schedule = null
  } = options || {};

  const config = getLofConfig();
  
  // Manual override: offseason always wins
  if (config && config.holiday_mode === 'offseason') {
    return 'offline';
  }

  const isPlaying = fppStatus === 'playing';
  const hasPlayingNow = !!(playingNow && playingNow.trim());
  const isIntermission = hasPlayingNow && /intermission/i.test(playingNow);
  const isStandby = hasPlayingNow && /standby/i.test(playingNow);
  const isRealSong = hasPlayingNow && !isIntermission && !isStandby;

  // S4: Controls Paused - RF disabled but FPP playing
  if (!viewerControlEnabled && isPlaying && isRealSong) {
    return 'paused';
  }

  // S3: Intermission - playing intermission sequence
  if (viewerControlEnabled && isPlaying && isIntermission) {
    return 'intermission';
  }

  // S2: Showtime - playing real song with controls enabled
  if (viewerControlEnabled && isPlaying && isRealSong) {
    return 'showtime';
  }

  // S1: Pre-show - controls enabled but nothing playing yet
  if (viewerControlEnabled && !isPlaying) {
    // Check if we're within schedule window
    const showState = getShowState('idle');
    if (showState === 'offseason') {
      return 'offline';
    }
    return 'preshow';
  }

  // S5/S6: Off-hours or fully offline
  if (!viewerControlEnabled && !isPlaying) {
    const showState = getShowState('idle');
    if (showState === 'offseason') {
      return 'offline';
    }
    return 'offhours';
  }

  // Fallback
  return 'offhours';
}

/**
 * V1.5: Get button states based on show state
 * @param {string} showState - Result from computeShowState()
 * @returns {Object} Button enable/disable flags
 */
function getButtonStates(showState) {
  const states = {
    preshow:      { pickSong: true,  glow: true,  surprise: true,  speaker: true  },
    showtime:     { pickSong: true,  glow: true,  surprise: true,  speaker: true  },
    intermission: { pickSong: true,  glow: true,  surprise: true,  speaker: false },
    paused:       { pickSong: false, glow: true,  surprise: false, speaker: true  },
    offhours:     { pickSong: false, glow: true,  surprise: false, speaker: false },
    offline:      { pickSong: false, glow: true,  surprise: false, speaker: false }
  };
  
  return states[showState] || states.offhours;
}

/**
 * V1.5: Get smart time messaging for off-hours/offline states
 * Uses actual schedule data instead of arbitrary hour cutoffs
 * @param {string} showState - Result from computeShowState()
 * @returns {string} User-friendly time message
 */
function getSmartTimeMessage(showState) {
  const config = getLofConfig();
  const now = new Date();
  const hour = now.getHours();
  
  if (showState === 'offline') {
    return lofCopy('time_offline', 'See you next season! 💤');
  }
  
  if (showState === 'offhours') {
    // Smart logic: if it's very late (after midnight, before 5 AM), 
    // the show just ended - say "back tonight" not "back tomorrow"
    if (hour >= 0 && hour < 5) {
      return lofCopy('time_offhours_latenight', 'Show\'s over for tonight. Lights & requests back at 5 PM!');
    }
    
    // Normal daytime - show starts later
    if (hour >= 5 && hour < 17) {
      return lofCopy('time_offhours_daytime', 'Lights & requests open at 5 PM. First scheduled show at 6 PM!');
    }
    
    // Evening but show hasn't started or ended early
    return lofCopy('time_offhours_evening', 'Check back soon — the show runs most evenings.');
  }
  
  // For active states, no time message needed
  return '';
}

/**
 * V1.5: Update hero banner based on current show state
 * Supports both new (rf-hero-banner-*) and old (rf-viewer-banner, rf-banner-*) element IDs
 */
function updateBanner(phase, enabled) {
  // Try new elements first, fall back to old
  const banner = heroBannerEl || document.getElementById('rf-viewer-banner');
  const titleEl = heroBannerTitleEl || document.getElementById('rf-banner-title');
  const bodyEl = heroBannerBodyEl || document.getElementById('rf-banner-body');
  
  if (!banner || !titleEl || !bodyEl) return;
  
  const config = getLofConfig();
  
  // Use the currentShowState computed by the state machine for consistency
  const showState = currentShowState;
  
  // Determine class prefix based on which elements we're using
  const isNewStructure = !!heroBannerEl;
  const classPrefix = isNewStructure ? 'rf-hero-banner' : 'rf-viewer-banner';
  
  // Default: hide banner
  banner.style.display = 'none';
  banner.className = classPrefix;
  
  // Also update smart time message
  updateSmartTimeMessage(showState);
  
  // Manual override: offseason always wins
  if (config && config.holiday_mode === 'offseason') {
    banner.style.display = 'block';
    banner.classList.add(classPrefix + '--offseason');
    titleEl.textContent = lofCopy('banner_offseason_title', 'We\'re resting up for next season');
    bodyEl.textContent = lofCopy('banner_offseason_body', 'Check back soon for more glowing chaos.');
    return;
  }

  if (showState === 'showtime') {
    banner.style.display = 'block';
    banner.classList.add(classPrefix + '--showtime');
    titleEl.textContent = lofCopy('banner_showtime_title', 'Showtime 🎶');
    bodyEl.textContent = lofCopy('banner_showtime_body', 'Lights, audio, and neighbors in sync.');
    return;
  }

  if (showState === 'intermission') {
    banner.style.display = 'block';
    banner.classList.add(classPrefix + '--intermission');
    titleEl.textContent = lofCopy('banner_intermission_title', 'We\'re taking a breather');
    bodyEl.textContent = lofCopy('banner_intermission_body', 'The lights are catching their breath. Queue up your next request!');
    return;
  }

  if (showState === 'preshow') {
    banner.style.display = 'block';
    banner.classList.add(classPrefix + '--preshow');
    titleEl.textContent = lofCopy('banner_preshow_title', 'Getting ready ✨');
    bodyEl.textContent = lofCopy('banner_preshow_body', 'The show is warming up. Get your requests in!');
    return;
  }
  
  if (showState === 'paused') {
    banner.style.display = 'block';
    banner.classList.add(classPrefix + '--paused');
    titleEl.textContent = lofCopy('banner_paused_title', 'Controls paused');
    bodyEl.textContent = lofCopy('banner_paused_body', 'Enjoy the show — we\'ll turn requests back on soon.');
    return;
  }

  if (showState === 'offhours' || showState === 'offline') {
    banner.style.display = 'block';
    banner.classList.add(classPrefix + '--offhours');
    titleEl.textContent = lofCopy('banner_offhours_title', 'Show\'s taking a break');
    bodyEl.textContent = lofCopy('banner_offhours_body', 'The lights are resting until the next show.');
    return;
  }
}

/**
 * V1.5: Update smart time message
 * Shows "Show starts at 5 PM!" when off-hours
 */
function updateSmartTimeMessage(showState) {
  if (!heroTimeEl) return;
  
  const message = getSmartTimeMessage(showState);
  
  if (message) {
    heroTimeEl.textContent = message;
    heroTimeEl.style.display = 'block';
  } else {
    heroTimeEl.style.display = 'none';
  }
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

  // V1.5: Update hero CTA section based on mode
  function updateHeaderCopy(mode, enabled, prefs, queueLength, phase) {
    // V1.5: Use new hero CTA elements, fall back to old IDs for compatibility
    const headlineEl = heroCtaTitleEl || document.getElementById('rf-viewer-headline');
    const subcopyEl  = heroCtaBodyEl || document.getElementById('rf-viewer-subcopy');
    if (!headlineEl || !subcopyEl) return;

    // Hide CTA if controls are disabled (banner shows the message instead)
    if (heroCtaEl && !enabled) {
      heroCtaEl.style.display = 'none';
      return;
    } else if (heroCtaEl) {
      heroCtaEl.style.display = 'block';
    }

    const locationMethod = prefs.locationCheckMethod || 'NONE';
    const late = isLateNight();
    let parts = [];

    if (mode === 'JUKEBOX') {
      const title = lofCopy(
        'header_jukebox_title',
        'Tap a song to request it 🎧'
      );
      headlineEl.textContent = title;

      const intro = lofCopy(
        'header_jukebox_intro',
        'Requests join the queue in the order they come in.'
      );
      parts.push(intro);

      if (queueLength > 0) {
        parts.push('There are currently ' + queueLength + ' songs in the queue.');
      }

      // Shortened fairness message
      parts.push(
        lofCopy(
          'header_jukebox_fair',
          'You can request songs from this device while the queue is open. If the queue gets extra long, we may pause new requests so everyone gets a turn.'
        )
      );

      // Show geo notice if geo check is enabled
      if (locationMethod && locationMethod !== 'NONE') {
        parts.push("You're officially part of the neighborhood DJ crew.");
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
      subcopyEl.textContent = intro;
      applyPersonaToSubcopy(subcopyEl);
      return;
    }

    // Fallback
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

  // V1.5: Update personalized status line with estimated wait time
  function updateMyStatusLine(nowSeq, queue, nowKey) {
    // V1.5: Use new hero mystatus element, fall back to old ID
    const el = heroMyStatusEl || document.getElementById('rf-viewer-my-status');
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

    // V1.5 Bundle B: Get current song's remaining time for wait calculation
    let currentSongRemaining = 0;
    if (window.LOFNowTiming && typeof window.LOFNowTiming.duration === 'number') {
      const timing = window.LOFNowTiming;
      const baseElapsed = typeof timing.elapsed === 'number' ? timing.elapsed : 0;
      const startedAt = typeof timing.updatedAt === 'number' ? timing.updatedAt : Date.now();
      const deltaSec = Math.max(0, (Date.now() - startedAt) / 1000);
      const elapsed = Math.min(timing.duration, baseElapsed + deltaSec);
      currentSongRemaining = Math.max(0, timing.duration - elapsed);
    }

    if (Array.isArray(queue)) {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        if (!item || typeof item !== 'object') continue;

        const seq   = item.sequence || {};
        const key   = seq.name || seq.displayName;
        const label = seq.displayName || seq.name || '';
        const duration = seq.duration || 0;

        if (!key) continue;
        if (requestedSongNames.includes(key)) {
          const pos = i + 1;
          
          // V1.5 Bundle B: Calculate estimated wait time including current song
          let estimatedWaitSec = currentSongRemaining; // Start with current song's remaining time
          for (let j = 0; j < i; j++) {
            const prevItem = queue[j];
            if (prevItem && prevItem.sequence) {
              estimatedWaitSec += (prevItem.sequence.duration || 180); // default 3 min
            }
          }
          
          queueMatches.push({ 
            name: label || key, 
            pos: pos,
            estimatedWait: estimatedWaitSec
          });
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
          parts.push('Your request "' + nowMatches[0] + '" is playing right now. Enjoy the glow ✨');
        } else {
          parts.push('One of your picks is playing now! (' + nowMatches.join(', ') + ')');
        }
      }

      if (hasQueueMatches) {
        if (queueMatches.length === 1) {
          const item = queueMatches[0];
          // V1.5: Include estimated wait time
          const waitMin = Math.round(item.estimatedWait / 60);
          let queueText = 'Your song "' + item.name + '" is currently #' + item.pos + ' in the queue';
          if (waitMin > 0) {
            queueText += ' (~' + waitMin + ' min wait)';
          } else {
            queueText += ' (up next!)';
          }
          queueText += '.';
          parts.push(hasNowMatches ? queueText.replace(/^Your/, 'Plus your') : queueText);
        } else {
          // V1.5 Bundle B: Consistent format for multiple songs
          const queueParts = queueMatches
            .sort((a, b) => a.pos - b.pos)
            .map(function(x) {
              const waitMin = Math.round(x.estimatedWait / 60);
              const waitText = waitMin > 0 ? '~' + waitMin + ' min wait' : 'up next!';
              return '"' + x.name + '" (#' + x.pos + ', ' + waitText + ')';
            });
          const queueText = 'Your picks are moving up: ' + queueParts.join(', ');
          parts.push(hasNowMatches ? queueText.replace(/^Your/, 'Plus your') : queueText);
        }
      }

      text = parts.join(' ');
    } else {
      text = 'Your previous requests have played. Pick another to keep the show moving. 🎶';
    }

    el.textContent = text;
    el.style.display = text ? 'block' : 'none';

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
  // V1.5: Updated to use show state machine for button gating
  function renderControlsRow(mode, enabled, showState) {
    const row = document.getElementById('rf-controls-row');
    if (!row) return;

    // Clear and rebuild each time to avoid duplicate listeners
    row.innerHTML = '';

    // Get button states from show state machine
    const buttonStates = getButtonStates(showState || 'offhours');

    const makeBtn = (label, isEnabled) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rf-ctl-link';
      if (!isEnabled) {
        b.classList.add('rf-ctl-link--disabled');
        b.disabled = true;
      }
      b.textContent = label;
      return b;
    };

    // Need sound? → scroll to the speaker card / extras panel
    // V1.5: Disabled during intermission per show state
    const btnSound = makeBtn('Need sound?', buttonStates.speaker);
    if (buttonStates.speaker) {
      btnSound.addEventListener('click', () => {
        const target =
          document.querySelector('.rf-speaker-card') ||
          document.getElementById('rf-extra-panel');
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
    row.appendChild(btnSound);

    // Send a Glow → scroll to footer Glow section
    // V1.5: Always enabled (glows work in all states)
    const btnGlow = makeBtn('Send a Glow 💛', buttonStates.glow);
    if (buttonStates.glow) {
      btnGlow.addEventListener('click', () => {
        const target =
          document.getElementById('rf-footer-glow') ||
          document.querySelector('.rf-glow-card') ||
          document.querySelector('.rf-tonight');
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
    row.appendChild(btnGlow);

    // Surprise me → V1.5: Uses show state for enable/disable
    const btnSurprise = makeBtn('Surprise me ✨', buttonStates.surprise);
    if (buttonStates.surprise) {
      btnSurprise.addEventListener('click', () => {
        handleSurpriseMe();
        const target = document.querySelector('.rf-card--surprise');
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }
    row.appendChild(btnSurprise);

    // Update row class based on overall control state
    if (enabled && (buttonStates.pickSong || buttonStates.surprise)) {
      row.classList.remove('rf-controls-row--disabled');
    } else {
      row.classList.add('rf-controls-row--disabled');
    }
  }

  /* -------------------------
   * V1.5: Category Helpers
   * ------------------------- */

  /**
   * Group sequences by category, respecting CATEGORY_ORDER
   * @param {Array} sequences - Visible sequences
   * @returns {Array} Array of { category: string, sequences: Array }
   */
  function groupSequencesByCategory(sequences) {
    if (!Array.isArray(sequences) || sequences.length === 0) {
      return [{ category: null, sequences: [] }];
    }

    // Build a map of category -> sequences
    const categoryMap = new Map();
    const uncategorized = [];

    sequences.forEach(seq => {
      const cat = seq.category || null;
      if (cat) {
        if (!categoryMap.has(cat)) {
          categoryMap.set(cat, []);
        }
        categoryMap.get(cat).push(seq);
      } else {
        uncategorized.push(seq);
      }
    });

    // If no categories exist, return all sequences without grouping
    if (categoryMap.size === 0) {
      return [{ category: null, sequences: sequences }];
    }

    // Sort categories according to CATEGORY_ORDER
    const sortedCategories = Array.from(categoryMap.keys()).sort((a, b) => {
      const aIndex = CATEGORY_ORDER.indexOf(a);
      const bIndex = CATEGORY_ORDER.indexOf(b);
      
      // If both are in the order list, sort by position
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      // If only a is in the list, a comes first
      if (aIndex !== -1) return -1;
      // If only b is in the list, b comes first
      if (bIndex !== -1) return 1;
      // Neither in list, sort alphabetically
      return a.localeCompare(b);
    });

    // Build result array
    const result = sortedCategories.map(cat => ({
      category: cat,
      sequences: categoryMap.get(cat)
    }));

    // Add uncategorized at the end if any exist
    if (uncategorized.length > 0) {
      result.push({ category: null, sequences: uncategorized });
    }

    return result;
  }

  /**
   * Get unique categories from sequences
   * @param {Array} sequences - Visible sequences
   * @returns {Array} Sorted array of category names (null excluded)
   */
  function getUniqueCategories(sequences) {
    const categories = new Set();
    sequences.forEach(seq => {
      if (seq.category) {
        categories.add(seq.category);
      }
    });

    return Array.from(categories).sort((a, b) => {
      const aIndex = CATEGORY_ORDER.indexOf(a);
      const bIndex = CATEGORY_ORDER.indexOf(b);
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;
      return a.localeCompare(b);
    });
  }

  /**
   * Render category tabs for mobile
   * @param {Array} categories - Sorted category names
   * @param {Element} container - Container to render into
   */
  function renderCategoryTabs(categories, container) {
    if (!container) return;
    
    // Remove existing tabs wrapper (includes title)
    const existingWrapper = container.querySelector('.rf-category-section');
    if (existingWrapper) {
      existingWrapper.remove();
    }
    // Also remove old-style tabs without wrapper
    const existingTabs = container.querySelector('.rf-category-tabs');
    if (existingTabs) {
      existingTabs.remove();
    }

    // Don't render if no categories or only one
    if (!categories || categories.length <= 1) {
      activeCategoryFilter = null;
      return;
    }

    // Create wrapper for title + tabs
    const sectionWrapper = document.createElement('div');
    sectionWrapper.className = 'rf-category-section';

    // Add title
    const title = document.createElement('div');
    title.className = 'rf-category-title';
    title.textContent = lofCopy('category_section_title', 'Tonight\'s Songs');
    sectionWrapper.appendChild(title);

    // V1.5 Bundle B: Add scroll wrapper for fade indicator
    const scrollWrapper = document.createElement('div');
    scrollWrapper.className = 'rf-category-tabs-wrapper';

    const tabsWrapper = document.createElement('div');
    tabsWrapper.className = 'rf-category-tabs';

    // Handle scroll to toggle fade indicator
    tabsWrapper.addEventListener('scroll', () => {
      const isAtEnd = tabsWrapper.scrollLeft + tabsWrapper.clientWidth >= tabsWrapper.scrollWidth - 10;
      scrollWrapper.classList.toggle('scrolled-end', isAtEnd);
    });

    // "All" tab
    const allTab = document.createElement('button');
    allTab.type = 'button';
    allTab.className = 'rf-category-tab' + (activeCategoryFilter === null ? ' rf-category-tab--active' : '');
    allTab.textContent = 'All';
    allTab.addEventListener('click', () => {
      activeCategoryFilter = null;
      updateCategoryTabStates(tabsWrapper);
      filterGridByCategory(null);
    });
    tabsWrapper.appendChild(allTab);

    // Category tabs
    categories.forEach(cat => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'rf-category-tab' + (activeCategoryFilter === cat ? ' rf-category-tab--active' : '');
      tab.textContent = cat;
      tab.dataset.category = cat;
      tab.addEventListener('click', () => {
        activeCategoryFilter = cat;
        updateCategoryTabStates(tabsWrapper);
        filterGridByCategory(cat);
      });
      tabsWrapper.appendChild(tab);
    });

    scrollWrapper.appendChild(tabsWrapper);
    sectionWrapper.appendChild(scrollWrapper);

    // Insert section before the grid
    container.insertBefore(sectionWrapper, container.firstChild);
  }

  /**
   * Update active state on category tabs
   */
  function updateCategoryTabStates(tabsWrapper) {
    if (!tabsWrapper) return;
    const tabs = tabsWrapper.querySelectorAll('.rf-category-tab');
    tabs.forEach(tab => {
      const isAll = !tab.dataset.category;
      const isActive = isAll 
        ? activeCategoryFilter === null 
        : tab.dataset.category === activeCategoryFilter;
      tab.classList.toggle('rf-category-tab--active', isActive);
    });
  }

  /**
   * Filter grid cards by category (mobile tabs)
   */
  function filterGridByCategory(category) {
    const grid = document.getElementById('rf-grid');
    if (!grid) return;

    const cards = grid.querySelectorAll('.rf-card');
    cards.forEach(card => {
      const cardCategory = card.dataset.category || null;
      if (category === null) {
        // Show all
        card.style.display = '';
      } else if (cardCategory === category) {
        card.style.display = '';
      } else {
        card.style.display = 'none';
      }
    });

    // Also show/hide category headers
    const headers = grid.querySelectorAll('.rf-category-header');
    headers.forEach(header => {
      const headerCategory = header.dataset.category;
      if (category === null) {
        header.style.display = '';
      } else if (headerCategory === category) {
        header.style.display = '';
      } else {
        header.style.display = 'none';
      }
    });
  }

  /**
   * Check if we should show mobile tabs vs desktop headers
   */
  function isMobileView() {
    return window.innerWidth < 700;
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
    
    // V1.5 FIX: Use unified state's requests.allowed which accounts for lockout
    // Falls back to RF's viewerControlEnabled if unified state unavailable
    if (viewerState && viewerState.requestsAllowed) {
      currentControlEnabled = !!viewerState.requestsAllowed.allowed;
    } else {
      currentControlEnabled = !!prefs.viewerControlEnabled;
    }

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
    let nextIsFromQueue = false;  // V1.5: Track if next is from RF queue (for badge display)

    // V1.5 FIX: If there are queued requests, ALWAYS show the first one as "Next Up"
    // This takes priority over RF's playingNext which might say "Intermission"
    if (rawRequests.length > 0 && rawRequests[0].sequence) {
      nextSeq = rawRequests[0].sequence;
      nextIsFromQueue = true;  // This next song came from the queue
    }

    // Only fall back to RF's playingNext if there's nothing in the queue
    if (!nextSeq) {
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
    }

    const nowDisplay = nowSeq
      ? (nowSeq.displayName || nowSeq.name || playingNowRaw)
      : (playingNowRaw || 'Nothing currently playing');

    const nextDisplayRaw = playingNextRaw || playingNextFromSchedule || '';

    // When RF doesn't provide an explicit "next" (intermission, idle, or empty
    // queue), avoid a sad-looking blank by showing a friendly fallback while
    // the show is clearly active.
    const isIntermissionTitle =
      nowDisplay && /intermission/i.test(nowDisplay.toString());
    const hasAnyQueue =
      Array.isArray(rawRequests) && rawRequests.length > 0;
    const hasAnyActivity = !!playingNowRaw || hasAnyQueue;

    const nextDisplay = nextSeq
      ? (nextSeq.displayName || nextSeq.name || nextDisplayRaw)
      : (
          nextDisplayRaw ||
          (isIntermissionTitle || hasAnyActivity
            ? 'More music from tonight\u2019s playlist'
            : '—')
        );

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
    
    // V1.5: Enhanced display using unified state (if available)
    if (viewerState && viewerState.state) {
      const state = viewerState.state;
      const nextShow = state.nextResetTime || state.nextShowTime || 'soon';
      
      // Test mode indicator
      if (state.isTestMode && viewerRoot) {
        viewerRoot.classList.add('rf-test-mode');
      } else if (viewerRoot) {
        viewerRoot.classList.remove('rf-test-mode');
      }
      
      // Ensure we have a subtitle element for "Up Next"
      let nextSubtitleEl = document.getElementById('rf-next-subtitle');
      if (!nextSubtitleEl && nextTitleEl && nextTitleEl.parentNode) {
        nextSubtitleEl = document.createElement('div');
        nextSubtitleEl.id = 'rf-next-subtitle';
        nextSubtitleEl.className = 'rf-next-subtitle';
        nextTitleEl.parentNode.insertBefore(nextSubtitleEl, nextTitleEl.nextSibling);
      }
      
      // Enhanced "Up Next" display based on state - BRAND VOICE
      if (nextTitleEl) {
        let nextSubtitle = '';
        
        if (state.isAfterHours) {
          // After hours - warm, inviting
          const lightsTime = state.nextLightsOpenTime || '5pm';
          const isTomorrow = lightsTime.toLowerCase().includes('tomorrow');
          if (isTomorrow) {
            nextTitleEl.textContent = '🌙 The lights are resting';
            nextSubtitle = 'Back tomorrow at 5pm!';
          } else {
            nextTitleEl.textContent = '🌙 The lights are resting';
            nextSubtitle = 'See you at ' + lightsTime + '!';
          }
        } else if (state.isPreshow) {
          // Pre-show - lights come on at 5pm, shows at 6pm
          const lightsTime = state.nextLightsOpenTime || '5pm';
          nextTitleEl.textContent = '✨ See you at ' + lightsTime;
          nextSubtitle = 'Lights on, requests open!';
        } else if (state.mode === 'time_lockout') {
          // Time-based lockout - playful urgency
          nextTitleEl.textContent = 'Hold that thought — ' + nextShow + ' show\'s about to begin 🎄';
          nextSubtitle = '';
        } else if (state.mode === 'queue_lockout') {
          // Queue-based lockout - whimsical
          nextTitleEl.textContent = 'This hour\'s dance card is full ✨';
          nextSubtitle = 'Catch the ' + nextShow + ' show 🧝';
        } else if (state.isReset || state.mode === 'resetting') {
          nextTitleEl.textContent = '🎄 Show starting now!';
          nextSubtitle = '';
        } else if (viewerState.nextUp && viewerState.nextUp.displayName && hasAnyQueue) {
          // Queue has items - show next requested song
          nextTitleEl.textContent = '🎵 ' + viewerState.nextUp.displayName;
          nextSubtitle = 'Requested by a guest';
        } else if (state.isShowPlaylist && !hasAnyQueue) {
          // Show playlist (random inserts) with no queue - DJ is picking
          nextTitleEl.textContent = '🎲 DJ Falcon\'s picking next...';
          nextSubtitle = 'Or request your own below';
        } else if (viewerState.nextUp && viewerState.nextUp.displayName && viewerState.nextUp.source === 'playlist') {
          // Sequential playlist - we know the actual next song
          nextTitleEl.textContent = '🎵 ' + viewerState.nextUp.displayName;
          nextSubtitle = 'From tonight\'s playlist — or pick your own!';
        } else if (state.isIntermission && !hasAnyQueue) {
          // Intermission with empty queue - include next show time
          const showTime = state.nextShowTime || state.nextResetTime || '';
          if (showTime && showTime !== 'soon') {
            nextTitleEl.textContent = '🎶 Your call — pick a song or catch the ' + showTime + ' show';
          } else {
            nextTitleEl.textContent = '🎶 Your call — request a song below';
          }
          nextSubtitle = 'Music plays when you pick one!';
        } else if (!hasAnyQueue && isPlayingReal) {
          // Playing but no queue and no next info - friendly fallback
          nextTitleEl.textContent = '🎶 Request a song below';
          nextSubtitle = 'Your pick plays next!';
        }
        // If none of the above, keep the existing nextDisplay value
        
        // Update subtitle element
        if (nextSubtitleEl) {
          nextSubtitleEl.textContent = nextSubtitle;
          nextSubtitleEl.style.display = nextSubtitle ? 'block' : 'none';
        }
      }
      
      // Enhanced "Now Playing" subtitle - show source but NOT time (progress bar handles that)
      if (nowArtistEl && isPlayingReal && viewerState.now) {
        const nowInfo = viewerState.now;
        
        if (nowInfo.isRequest) {
          // Don't overwrite artist - just add source indicator if no artist
          if (!nowArtist) {
            nowArtistEl.textContent = 'Requested by a guest ✨';
          }
          // If there IS an artist, keep it (don't add time - progress bar shows that)
        } else if (!nowArtist) {
          // No artist and not a request - show playlist source
          nowArtistEl.textContent = 'From tonight\'s playlist';
        }
        // If there's an artist, just keep the original artist text
      }
    }

    // (Now Playing progress bar handled by FPP status polling)

    const queueLength = rawRequests.length || 0;
    const phase = isIntermission ? 'intermission' : (isPlayingReal ? 'showtime' : 'idle');
    lastPhase = phase;

    // V1.5: Compute comprehensive show state for UI controls
    // Derive FPP status from what we know about current playback
    const derivedFppStatus = (hasRawNow || isIntermission) ? 'playing' : 'idle';
    currentShowState = computeShowState({
      viewerControlEnabled: currentControlEnabled,
      playingNow: playingNowRaw,
      fppStatus: derivedFppStatus
    });

    // V1.5: Add show state class to viewer root for CSS targeting
    if (viewerRoot) {
      // Remove old state classes
      viewerRoot.classList.remove(
        'rf-state-preshow', 'rf-state-showtime', 'rf-state-intermission',
        'rf-state-paused', 'rf-state-offhours', 'rf-state-offline'
      );
      viewerRoot.classList.add('rf-state-' + currentShowState);
    }

    updateHeaderCopy(currentMode, currentControlEnabled, prefs, queueLength, phase);
    updateBanner(phase, currentControlEnabled);
    updateMyStatusLine(nowSeq, rawRequests, nowKey);
    renderControlsRow(currentMode, currentControlEnabled, currentShowState);

    if (!gridEl) return;
    gridEl.innerHTML = '';

    // V1.5: Get unique categories first to know if we need category sorting
    const allVisibleSequences = sequences
      .filter((s) => s.visible && s.active);
    
    const categories = getUniqueCategories(allVisibleSequences);
    const hasCategories = categories.length > 1;
    const mobile = isMobileView();

    // V1.5: Sort sequences - on desktop with categories, sort by category first
    let visibleSequences;
    if (hasCategories && !mobile) {
      // Desktop with categories: sort by category order, then by sequence order
      visibleSequences = allVisibleSequences.slice().sort((a, b) => {
        const aCat = a.category || '';
        const bCat = b.category || '';
        
        // Get category order indices
        const aCatIndex = CATEGORY_ORDER.indexOf(aCat);
        const bCatIndex = CATEGORY_ORDER.indexOf(bCat);
        
        // Category comparison
        let catCompare;
        if (aCatIndex !== -1 && bCatIndex !== -1) {
          catCompare = aCatIndex - bCatIndex;
        } else if (aCatIndex !== -1) {
          catCompare = -1; // a's category is in list, b's isn't
        } else if (bCatIndex !== -1) {
          catCompare = 1; // b's category is in list, a's isn't
        } else if (aCat && bCat) {
          catCompare = aCat.localeCompare(bCat); // alphabetical
        } else if (aCat) {
          catCompare = -1; // a has category, b doesn't
        } else if (bCat) {
          catCompare = 1; // b has category, a doesn't
        } else {
          catCompare = 0; // neither has category
        }
        
        if (catCompare !== 0) return catCompare;
        
        // Within same category, sort by order
        const ao = typeof a.order === 'number' ? a.order : 9999;
        const bo = typeof b.order === 'number' ? b.order : 9999;
        return ao - bo;
      });
    } else {
      // Mobile or no categories: just sort by order
      visibleSequences = allVisibleSequences.slice().sort((a, b) => {
        const ao = typeof a.order === 'number' ? a.order : 9999;
        const bo = typeof b.order === 'number' ? b.order : 9999;
        return ao - bo;
      });
    }

    currentVisibleSequences = visibleSequences;

    // V1.5: Render category tabs for mobile (above grid)
    if (hasCategories && mobile) {
      const gridParent = gridEl.parentElement;
      if (gridParent) {
        renderCategoryTabs(categories, gridParent);
      }
    } else {
      // Remove tabs if not needed
      const gridParent = gridEl.parentElement;
      if (gridParent) {
        const existingSection = gridParent.querySelector('.rf-category-section');
        if (existingSection) existingSection.remove();
        const existingTabs = gridParent.querySelector('.rf-category-tabs');
        if (existingTabs) existingTabs.remove();
      }
      activeCategoryFilter = null;
    }

    // V1.5: Track which category we last rendered (for headers)
    let lastRenderedCategory = null;
    let uncategorizedHeaderShown = false;

    visibleSequences.forEach((seq) => {
      // V1.5: Desktop category headers - insert before first card of each category
      if (hasCategories && !mobile) {
        const seqCategory = seq.category || null;
        
        if (seqCategory && seqCategory !== lastRenderedCategory) {
          // Normal category header
          const header = document.createElement('div');
          header.className = 'rf-category-header';
          header.dataset.category = seqCategory;
          
          // Count songs in this category
          const categoryCount = visibleSequences.filter(s => s.category === seqCategory).length;
          header.innerHTML = `
            <span class="rf-category-header-text">${escapeHtml(seqCategory)}</span>
            <span class="rf-category-header-count">${categoryCount} songs</span>
          `;
          gridEl.appendChild(header);
          lastRenderedCategory = seqCategory;
        } else if (!seqCategory && !uncategorizedHeaderShown) {
          // Uncategorized songs header - show once before first uncategorized song
          const uncatCount = visibleSequences.filter(s => !s.category).length;
          if (uncatCount > 0) {
            const header = document.createElement('div');
            header.className = 'rf-category-header rf-category-header--other';
            header.dataset.category = '';
            header.innerHTML = `
              <span class="rf-category-header-text">More Songs</span>
              <span class="rf-category-header-count">${uncatCount} songs</span>
            `;
            gridEl.appendChild(header);
            uncategorizedHeaderShown = true;
          }
        }
      }

      const card = document.createElement('div');
      card.className = 'rf-card';

      // V1.5: Add category data attribute for filtering
      if (seq.category) {
        card.dataset.category = seq.category;
      }

      const isNow  = nowKey  && (seq.name === nowKey  || seq.displayName === nowKey);
      // V1.5 FIX: Show "Next up" badge for:
      // 1. Queue items (nextIsFromQueue = true)
      // 2. Sequential playlists where we know the next song (source === 'playlist')
      // But NOT for show playlists (random inserts) where the next song is unpredictable
      let isNext = false;
      if (nextKey && (seq.name === nextKey || seq.displayName === nextKey)) {
        if (nextIsFromQueue) {
          // Queue determines next - always show badge
          isNext = true;
        } else if (viewerState && viewerState.nextUp && viewerState.nextUp.source === 'playlist') {
          // Sequential playlist - show badge for known next song
          isNext = true;
        }
        // Note: source === 'show_playlist' means random inserts, don't show badge
      }

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

      let showRequestedChip = wasRequested;
      
      // V1.5 Bundle B FIX: Check session names for ALL cards, not just isNow
      // This ensures the chip shows immediately after requesting, before RF confirms
      if (!showRequestedChip && sessionRequestedNames.size > 0) {
        if (
          (keyName && sessionRequestedNames.has(keyName)) ||
          (labelName && sessionRequestedNames.has(labelName))
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

    // V1.5: Apply category filter if active (mobile tabs)
    if (hasCategories && mobile && activeCategoryFilter) {
      filterGridByCategory(activeCategoryFilter);
    }

    // V1.5: Surprise-Me card (render once per details refresh)
    addSurpriseCard();

    // V1.5: Only re-render the extras panel when its core inputs change.
    // This keeps the "Tonight from this device" Mischief Meter and the
    // speaker "time left" timer from blinking every few seconds as
    // showDetails polls, while still updating when it actually matters.
    const extraSignature = JSON.stringify({
      mode: currentMode,
      enabled: currentControlEnabled,
      queueLength: queueLength,
      phase: phase
    });

    if (extraSignature !== lastExtraSignature) {
      lastExtraSignature = extraSignature;

      // Rebuild geo card + queue/leaderboard + device stats + speaker card
      // only when viewer mode, enabled state, queue length, or phase change.
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

    // V1.5: Always perform geo check so the geo card stays in sync.
    // Wrapped in try/catch so a geo error can never break the queue / stats panel.
    try {
      performGeoCheck(extra);
    } catch (e) {
      console.warn('[LOF V1.5] Geo check failed:', e);
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

  // V1.5: Show queue song count (not duration - that's confusing)
  if (rawRequests.length > 0) {
    const countDiv = document.createElement('div');
    countDiv.className = 'rf-queue-count';
    const songWord = rawRequests.length === 1 ? 'song' : 'songs';
    countDiv.innerHTML = `<span class="rf-queue-count-value">${rawRequests.length}</span> <span class="rf-queue-count-label">${songWord} queued</span>`;
    wrapper.appendChild(countDiv);
  }

  // V1.5: Add reset warning banner if within 15 minutes of reset
  if (viewerState && viewerState.state) {
    const state = viewerState.state;
    if (state.timeUntilResetSeconds && state.timeUntilResetSeconds < 900) {
      const resetMin = Math.ceil(state.timeUntilResetSeconds / 60);
      const nextShow = state.nextResetTime || state.nextShowTime || 'soon';
      const warningDiv = document.createElement('div');
      warningDiv.className = 'rf-queue-warning';
      
      if (state.isLockout) {
        if (state.lockoutReason === 'queue') {
          // Queue-based lockout - brand voice
          warningDiv.innerHTML = `
            <span class="rf-queue-warning-icon">✨</span>
            <span>This hour's dance card is full — catch the ${nextShow} show 🧝</span>
          `;
        } else {
          // Time-based lockout - brand voice
          warningDiv.innerHTML = `
            <span class="rf-queue-warning-icon">🎄</span>
            <span>Hold that thought — ${nextShow} show's about to begin!</span>
          `;
        }
      } else {
        // Warning but not locked out yet
        warningDiv.innerHTML = `
          <span class="rf-queue-warning-icon">⏱️</span>
          <span>Queue resets at ${nextShow} (${resetMin} min) — request now!</span>
        `;
      }
      wrapper.appendChild(warningDiv);
    }
  }

  // No requests – keep the card compact with a single explanatory line
  if (!rawRequests.length) {
    const empty = document.createElement('div');
    empty.className = 'rf-extra-sub rf-queue-empty';
    empty.innerHTML = '✨ Queue is clear — your request plays next!';
    wrapper.appendChild(empty);
    extra.appendChild(wrapper);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'rf-queue-list';
  
  // V1.5: Get wait times from unified state if available
  const enhancedQueue = (viewerState && viewerState.queue) ? viewerState.queue : null;

  rawRequests.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;

    const seq = (item.sequence && typeof item.sequence === 'object') ? item.sequence : {};
    const displayTitle = seq.displayName || seq.name || 'Untitled';
    const artist       = seq.artist || '';
    const pos          = idx + 1;
    
    // V1.5: Get wait time from enhanced queue if available
    let waitTimeStr = '';
    if (enhancedQueue && enhancedQueue[idx]) {
      const waitSeconds = enhancedQueue[idx].waitSeconds || 0;
      waitTimeStr = formatWaitTime(waitSeconds, pos);
    } else {
      // Fallback: show position-based text
      waitTimeStr = pos === 1 ? 'up next' : '';
    }

    const li = document.createElement('li');
    li.className = 'rf-queue-item';
    li.innerHTML = `
      <span class="rf-queue-position">#${pos}</span>
      <span class="rf-queue-song">${escapeHtml(displayTitle)}</span>
      ${waitTimeStr ? `<span class="rf-queue-wait">${waitTimeStr}</span>` : ''}
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

  // V1.5 ENHANCED: Vibe check factors in multiple signals, not just queue
  const vibeLabel = lofCopy('stats_vibe_label', 'Falcon vibe check');
  
  // Calculate activity score from multiple sources
  const deviceRequests = stats.requests || 0;
  const deviceSurprises = stats.surprise || 0;
  const baseActivity = queueLength + (deviceRequests * 0.3) + (deviceSurprises * 0.5);
  
  // Time-based boost: later = more energy (after 8 PM = +1, after 10 PM = +2)
  const hour = new Date().getHours();
  const timeBoost = hour >= 22 ? 2 : (hour >= 20 ? 1 : 0);
  
  const activityScore = baseActivity + timeBoost;
  
  let vibeText;
  if (activityScore >= 8) {
    vibeText = lofCopy('stats_vibe_high', 'Full-send Falcon 🔥');
  } else if (activityScore >= 4) {
    vibeText = lofCopy('stats_vibe_med', 'Party forming 🕺');
  } else if (activityScore >= 2) {
    vibeText = lofCopy('stats_vibe_warming', 'Warming up ✨');
  } else {
    vibeText = lofCopy('stats_vibe_low', 'Cozy & chill 😌');
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

  // Lazy-load Show Activity counts and enhance the card in-place
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
      sectionLabel.textContent = lofCopy('trigger_overall_label', 'Show Activity');
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

      // V1.5 Bundle B: Add speaker presses if available
      if (typeof triggers.speaker !== 'undefined') {
        const rawSpeaker =
          typeof triggers.speaker === 'number'
            ? triggers.speaker
            : parseInt(triggers.speaker, 10) || 0;

        const row = document.createElement('div');
        row.className = 'rf-stat-item rf-stats-row--mischief';
        row.innerHTML = `
          <span class="rf-stat-label">
            ${escapeHtml(lofCopy('trigger_speaker_label', '🔊 Speaker button taps:'))}
          </span>
          <span class="rf-stat-value">${rawSpeaker}</span>
        `;
        body.appendChild(row);
      }

      // V1.5 Bundle B: Add popular songs if available
      if (triggers.popular_tonight) {
        const row = document.createElement('div');
        row.className = 'rf-stat-item rf-stats-row--popular';
        row.innerHTML = `
          <span class="rf-stat-label">
            ${escapeHtml(lofCopy('trigger_popular_tonight', '🎵 Most requested tonight:'))}
          </span>
          <span class="rf-stat-value rf-stat-value--song">${escapeHtml(triggers.popular_tonight)}</span>
        `;
        body.appendChild(row);
      }

      if (triggers.popular_alltime) {
        const row = document.createElement('div');
        row.className = 'rf-stat-item rf-stats-row--popular';
        row.innerHTML = `
          <span class="rf-stat-label">
            ${escapeHtml(lofCopy('trigger_popular_alltime', '👑 All-time favorite:'))}
          </span>
          <span class="rf-stat-value rf-stat-value--song">${escapeHtml(triggers.popular_alltime)}</span>
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
          <span class="rf-glow-charcount">0 / 500</span>
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
    const maxLen = 500;
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

  // V1.5: Check if speaker button should be disabled based on show state
  const speakerBlockedStates = ['intermission', 'offhours', 'offline'];
  const speakerDisabled = speakerBlockedStates.includes(currentShowState);

  // V1.5 Bundle B: State-aware intro text
  let introText;
  if (currentShowState === 'intermission') {
    introText = lofCopy('speaker_intro_intermission', 'Speakers available when the next song starts. You can also listen on your phone or in your car.');
  } else if (currentShowState === 'offhours' || currentShowState === 'offline') {
    introText = lofCopy('speaker_intro_offhours', 'The show is currently off. When it\'s running, you can hear the music outside, on your phone, or in your car.');
  } else {
    introText = lofCopy('speaker_intro', 'Choose how you want to hear the show — outside speakers, on your phone, or in your car.');
  }

  const card = document.createElement('div');
  card.className = 'rf-card rf-speaker-card rf-card--speaker'; // V1.5: Add --speaker class

  card.innerHTML = `
    <div class="rf-speaker-card-inner">
      <div class="rf-speaker-header">
        <div class="rf-label">${escapeHtml(lofCopy('speaker_label', 'Need sound?'))}</div>
        <div class="rf-speaker-body">
          ${escapeHtml(introText)}
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
          ${escapeHtml(speakerDisabled ? 'Speakers unavailable' : btnLabelOn)}
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
        <div class="rf-audio-help">
          ${escapeHtml(
            lofCopy(
              'speaker_stream_help',
              'Use the audio bar at the bottom of this page to listen on your phone. Tap play and leave this page open while you explore the controls.'
            )
          )}
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

  // V1.5: Apply disabled state to speaker button based on show state
  if (btn && speakerDisabled) {
    btn.disabled = true;
    btn.classList.add('rf-speaker-btn--disabled');
  }

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
          // Speaker ON - use our clean status text, not API message
          const statusOnText = lofCopy(
            'speaker_status_on',
            'Speakers are ON! 🔊'
          );
          // V1.5 Bundle B: Always use our clean status text, ignore API message
          statusText.textContent = statusOnText;

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
          // Speaker OFF - V1.5 Bundle B: State-aware status text
          let statusOffText;
          if (speakerBlockedStates.includes(currentShowState)) {
            if (currentShowState === 'intermission') {
              statusOffText = lofCopy('speaker_status_off_intermission', 'Speakers available when the next song starts.');
            } else {
              statusOffText = lofCopy('speaker_status_off_offhours', 'Speakers available when the show is running.');
            }
          } else {
            statusOffText = lofCopy('speaker_status_off', 'Speakers are currently OFF. Tap the button below to turn them on.');
          }

          statusText.textContent = statusOffText;
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
      // V1.5: Block speakers during intermission, offhours, and offline states
      // Uses the show state machine for consistent behavior across the UI
      const blockedStates = ['intermission', 'offhours', 'offline'];
      if (blockedStates.includes(currentShowState)) {
        let msg;
        if (currentShowState === 'intermission') {
          msg = lofCopy(
            'speaker_intermission_blocked',
            'Speakers only come on during show songs so intermission stays a little quieter.'
          );
        } else {
          msg = lofCopy(
            'speaker_offhours_blocked',
            'Speakers are only available during show hours. Check back when the lights are on!'
          );
        }
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

  // Remove any existing surprise card so we don't duplicate on re-render
  const existing = gridEl.querySelector('.rf-card--surprise');
  if (existing && existing.parentNode === gridEl) {
    gridEl.removeChild(existing);
  }

  const title = lofCopy('surprise_title', 'Can’t pick just one?');
  const sub   = lofCopy(
    'surprise_sub',
    'Let us queue up a random crowd-pleaser for you.'
  );
  const btnLabelEnabled  = lofCopy('surprise_btn', 'Surprise me ✨');
  const btnLabelDisabled = lofCopy(
    'surprise_disabled',
    'Viewer control is currently paused.'
  );

  const card = document.createElement('div');
  card.className = 'rf-card rf-card--surprise';

  card.innerHTML = `
    <div class="rf-card-title">${escapeHtml(title)}</div>
    <div class="rf-card-artist">${escapeHtml(sub)}</div>
    <div class="rf-card-actions">
      <button class="rf-card-btn rf-card-btn--surprise">
        ${escapeHtml(currentControlEnabled ? btnLabelEnabled : btnLabelDisabled)}
      </button>
    </div>
  `;

  const btn = card.querySelector('.rf-card-btn--surprise');
  if (btn) {
    if (!currentControlEnabled) {
      // Keep the card visible but make it obvious that interaction is paused
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => {
        handleSurpriseMe();
      });
    }
  }

  gridEl.appendChild(card);
}

  /* -------------------------
   * Actions (request / vote)
   * ------------------------- */

  function getButtonLabel(mode, controlEnabled) {
    if (!controlEnabled) {
      // V1.5: Check if it's a lockout for better button text
      if (viewerState && viewerState.state && viewerState.state.isLockout) {
        return 'Show starting soon ✨';
      }
      return 'Requests paused';
    }
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
      // V1.5: Check if it's a lockout situation for better messaging
      if (viewerState && viewerState.state && viewerState.state.isLockout) {
        const nextShow = viewerState.state.nextResetTime || viewerState.state.nextShowTime || 'soon';
        if (viewerState.state.lockoutReason === 'queue') {
          showToast(`This hour's dance card is full ✨ Catch the ${nextShow} show!`, 'error');
        } else {
          showToast(`Hold that thought — ${nextShow} show's about to begin 🎄`, 'error');
        }
      } else {
        const msg = lofCopy(
          'viewer_action_disabled',
          'Requests are paused right now — enjoy the show! ✨'
        );
        showToast(msg, 'error');
      }
      return;
    }
    
    // V1.5: Smart blocking using unified state
    if (viewerState && viewerState.state) {
      const state = viewerState.state;
      const nextShow = state.nextResetTime || state.nextShowTime || 'soon';
      
      // Hard lockout - no requests allowed within 5 min of reset
      if (state.isLockout) {
        if (state.lockoutReason === 'queue') {
          showToast(`This hour's dance card is full ✨ Catch the ${nextShow} show!`, 'error');
        } else {
          showToast(`Hold that thought — ${nextShow} show's about to begin 🎄`, 'error');
        }
        return;
      }
      
      // Smart blocking - check if this song will finish in time
      if (state.timeUntilResetSeconds && seq.duration) {
        const queueWait = viewerState.queue ? 
          viewerState.queue.reduce((sum, q) => sum + (q.duration || 0), 0) : 0;
        const currentWait = (viewerState.now && viewerState.now.secondsRemaining) || 0;
        const totalTime = currentWait + queueWait + seq.duration + 60; // 60s buffer
        
        if (totalTime > state.timeUntilResetSeconds) {
          const resetMin = Math.ceil(state.timeUntilResetSeconds / 60);
          showToast(`This one's a bit long for ${resetMin} min left ⏱️ Try a shorter tune!`, 'error');
          return;
        }
      }
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
        let msg = (mode === 'VOTING')
          ? `Vote sent! You’re helping pick the next song.${codeMessage}`
          : `Request sent! You’re in the queue.${codeMessage}`;
        // V1.5: Add warning if close to reset
        if (viewerState && viewerState.state && viewerState.state.timeUntilResetSeconds < 600) {
          const resetMin = Math.ceil(viewerState.state.timeUntilResetSeconds / 60);
          msg += ` ⚡ Queue resets in ${resetMin} min`;
        }

        showToast(msg, 'success');

      if (mode === 'JUKEBOX') {
        const keyName = seq.name || '';
        const labelName = seq.displayName || '';

        // V1.5 FIX: Add to session Set (accumulates, never overwrites)
        if (keyName) {
          sessionRequestedNames.add(keyName);
        }
        if (labelName) {
          sessionRequestedNames.add(labelName);
        }

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
  
  // V1.5 FIX: Exclude ALL session-requested songs, not just the last one
  if (sessionRequestedNames.size > 0) {
    pool = pool.filter(seq => {
      const key = seq.name || seq.displayName;
      const label = seq.displayName || seq.name;
      return !sessionRequestedNames.has(key) && !sessionRequestedNames.has(label);
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
  
  // V1.5: Format seconds as M:SS
  function formatTimeRemaining(seconds) {
    if (!seconds || seconds <= 0) return '';
    const min = Math.floor(seconds / 60);
    const sec = Math.round(seconds % 60);
    return min + ':' + String(sec).padStart(2, '0');
  }
  
  // V1.5: Format wait time for queue display
  function formatWaitTime(seconds, position) {
    // Position 1 (first in queue) shows "up next" regardless of wait time
    if (position === 1 || position === 0) return 'up next';
    if (!seconds || seconds <= 0) return 'up next';
    const min = Math.ceil(seconds / 60);
    if (min < 1) return '<1 min';
    return '~' + min + ' min';
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