(function () {
  // ------------------------------
  // CONFIG – tweak here, not in logic.
  // ------------------------------

  const LOF_VIEWER_CONFIG = {
    // Local showtime windows (24h) – same every day for now
    showWindows: [
      { start: "17:00", end: "22:00" } // 5pm–10pm
    ],

    // Within this many minutes of next show, show a countdown
    countdownThresholdMinutes: 60,

    // How often to refresh speaker status (seconds)
    speakerPollSeconds: 5,

    text: {
      showtime: {
        kicker: "It’s showtime ✨",
        title: "You made it for the full experience.",
        body: "Lights, music, neighbors, chaos – this is when Falcon really hums. Pick a song or let the playlist work its magic."
      },
      adhoc: {
        kicker: "Choose-your-own-chaos mode 🎛️",
        title: "Show’s between sets, but the lights are still listening.",
        body: "You’ve got ad-hoc controls. Request a song, hit Surprise Me, or just let the lights vibe while you hang out."
      },
      offline: {
        kicker: "Off-hours 💤",
        title: "Falcon’s resting up for the next show.",
        body: "We’re not running a full show right now, but check back during posted showtimes for the full synced experience."
      },
      speaker: {
        off: "Sound nearby is currently OFF. If you’re here in person, tap “Need sound?” to bring the music outside for a bit.",
        onNoTime: "Sound is ON near the show.",
        onWithTime: (mins, seconds) => {
          if (mins <= 0) {
            return "Sound is ON near the show – under a minute left.";
          }
          if (seconds < 10) {
            return `Sound is ON near the show – about ${mins} minute${mins === 1 ? '' : 's'} left.`;
          }
          return `Sound is ON near the show – about ${mins} minute${mins === 1 ? '' : 's'} left.`;
        }
      }
    }
  };

  // ------------------------------
  // Time helpers
  // ------------------------------

  function parseTimeToMinutes(timeStr) {
    const parts = timeStr.split(":");
    if (parts.length !== 2) return null;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  }

  function getMinutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  function getNextShowWindow(config, nowMinutes) {
    const windows = config.showWindows
      .map(w => {
        const start = parseTimeToMinutes(w.start);
        const end   = parseTimeToMinutes(w.end);
        if (start === null || end === null) return null;
        return { start, end };
      })
      .filter(Boolean);

    if (!windows.length) return null;

    let current = null;
    let next    = null;
    let minDiff = Infinity;

    for (const w of windows) {
      if (nowMinutes >= w.start && nowMinutes < w.end) {
        current = w;
      } else if (nowMinutes < w.start) {
        const diff = w.start - nowMinutes;
        if (diff < minDiff) {
          minDiff = diff;
          next = w;
        }
      }
    }

    return { current, next };
  }

  // ------------------------------
  // RF mode reader (from DOM)
  // ------------------------------

  function getRFMode() {
    const el = document.getElementById('rf-mode-value');
    if (!el) return null;
    const raw = (el.textContent || "").trim().toUpperCase();

    if (!raw) return null;

    if (raw.includes('SHOW')) return 'SHOW';
    if (raw.includes('INTERACTIVE')) return 'INTERACTIVE';
    if (raw.includes('IDLE')) return 'IDLE';
    if (raw.includes('OFF')) return 'OFF';

    return raw;
  }

  // ------------------------------
  // DOM helpers
  // ------------------------------

  function setText(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
  }

  function setCountdownText(minutesUntil) {
    const el = document.getElementById('lof-show-countdown');
    if (!el) return;

    if (minutesUntil == null || minutesUntil <= 0) {
      el.textContent = '';
      el.style.display = 'none';
      return;
    }

    el.style.display = 'block';

    if (minutesUntil < 1) {
      el.textContent = "Next show starts in under a minute.";
    } else if (minutesUntil === 1) {
      el.textContent = "Next show starts in about 1 minute.";
    } else {
      el.textContent = `Next show starts in about ${minutesUntil} minutes.`;
    }
  }

  function formatMMSS(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    const mm = String(m);
    const ss = r < 10 ? '0' + r : String(r);
    return { m, r, label: `${mm}:${ss}` };
  }

  // ------------------------------
  // Speaker status fetch
  // ------------------------------

  function getSpeakerEndpoint() {
    // We know lof-speaker.php lives in the integrations theme
    return window.location.origin + '/wp-content/themes/integrations/lof-speaker.php?action=status';
  }

  async function fetchSpeakerStatus() {
    const url = getSpeakerEndpoint();
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return data;
    } catch (err) {
      // Fail quietly; we'll just not show status this tick
      return null;
    }
  }

  function updateSpeakerIndicator(data) {
    const el = document.getElementById('lof-speaker-indicator');
    if (!el) return;

    const texts = LOF_VIEWER_CONFIG.text.speaker;
    const msg   = (data && typeof data.message === 'string') ? data.message.trim() : '';

    if (!data || data.success !== true) {
      el.textContent = '';
      el.classList.remove('lof-speaker-indicator--on', 'lof-speaker-indicator--off');
      return;
    }

    const on  = !!data.speakerOn;
    const rem = typeof data.remainingSeconds === 'number' ? data.remainingSeconds : 0;
    const { m, label } = formatMMSS(rem);

    // Speaker OFF
    if (!on) {
      if (msg) {
        el.textContent = msg;
      } else {
        el.textContent = texts.off;
      }
      el.classList.add('lof-speaker-indicator--off');
      el.classList.remove('lof-speaker-indicator--on');
      return;
    }

    // Speaker ON
    let line;
    if (msg) {
      // Prefer backend-provided message, optionally append countdown
      line = msg;
      if (rem > 0) {
        line += ` (about ${label} left)`;
      }
    } else if (rem > 0) {
      line = texts.onWithTime(m, rem);
      line += ` (about ${label} left)`;
    } else {
      line = texts.onNoTime;
    }

    el.textContent = line;
    el.classList.add('lof-speaker-indicator--on');
    el.classList.remove('lof-speaker-indicator--off');
  }

  async function pollSpeakerStatus() {
    const data = await fetchSpeakerStatus();
    updateSpeakerIndicator(data);
  }

  // ------------------------------
  // Banner state updater (showtime / adhoc / offline)
  // ------------------------------

  function updateEpicBanner() {
    const root = document.getElementById('lof-epic-banner');
    if (!root) return;

    const now      = new Date();
    const nowMin   = getMinutesSinceMidnight(now);
    const mode     = getRFMode();
    const windows  = getNextShowWindow(LOF_VIEWER_CONFIG, nowMin);

    const texts    = LOF_VIEWER_CONFIG.text;
    let kicker, title, body;
    let minutesUntilNext = null;

    const inShowWindow = windows && windows.current;
    if (inShowWindow) {
      kicker = texts.showtime.kicker;
      title  = texts.showtime.title;
      body   = texts.showtime.body;
    } else {
      if (windows && windows.next) {
        minutesUntilNext = windows.next.start - nowMin;
      }

      if (minutesUntilNext != null &&
          minutesUntilNext > 0 &&
          minutesUntilNext <= LOF_VIEWER_CONFIG.countdownThresholdMinutes) {
        kicker = texts.adhoc.kicker;
        title  = texts.adhoc.title;
        body   = texts.adhoc.body;
      } else {
        kicker = texts.offline.kicker;
        title  = texts.offline.title;
        body   = texts.offline.body;
      }
    }

    // Refine message based on RF mode, if we know it
    if (mode === 'OFF') {
      kicker = texts.offline.kicker;
      title  = texts.offline.title;
      body   = texts.offline.body;
    } else if (mode === 'INTERACTIVE') {
      kicker = texts.adhoc.kicker;
      title  = texts.adhoc.title;
      body   = texts.adhoc.body;
    } else if (mode === 'SHOW') {
      kicker = texts.showtime.kicker;
      title  = texts.showtime.title;
      body   = texts.showtime.body;
    }

    setText('lof-banner-kicker', kicker);
    setText('lof-banner-title', title);
    setText('lof-banner-body', body);

    if (minutesUntilNext != null &&
        minutesUntilNext > 0 &&
        minutesUntilNext <= LOF_VIEWER_CONFIG.countdownThresholdMinutes) {
      setCountdownText(minutesUntilNext);
    } else {
      setCountdownText(null);
    }
  }

  // ------------------------------
  // Init
  // ------------------------------

  function initEpicViewer() {
    updateEpicBanner();
    pollSpeakerStatus();

    // Poll banner state (showtime/ad-hoc) every 30s
    setInterval(updateEpicBanner, 30000);

    // Poll speaker status more frequently
    const intervalMs = Math.max(3, LOF_VIEWER_CONFIG.speakerPollSeconds) * 1000;
    setInterval(pollSpeakerStatus, intervalMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEpicViewer);
  } else {
    initEpicViewer();
  }
})();