(function () {
  // ------------------------------
  // CONFIG – local defaults
  // ------------------------------

  const LOF_VIEWER_CONFIG = {
    // Local showtime windows (24h) – overridden by viewer-config if present
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
        body: "Lights, music, neighbors, chaos – this is when Falcon really hums."
      },
      adhoc: {
        kicker: "Choose-your-own-chaos mode 🎛️",
        title: "We’re between sets, but the lights are still listening.",
        body: "Request a song, hit Surprise Me, or just let the lights vibe while you hang out."
      },
      offline: {
        kicker: "Off-hours 💤",
        title: "Falcon’s resting up for the next show.",
        body: "We’re not running a full show right now, but check back during posted showtimes for the full synced experience."
      },
      speaker: {
        off: "Sound nearby is currently OFF. If you’re here in person, tap the sound button to bring the music outside for a bit.",
        onNoTime: "Sound is ON near the show.",
        onWithTime: function (mins, _seconds) {
          if (mins <= 0) {
            return "Sound is ON near the show – under a minute left.";
          }
          return "Sound is ON near the show – about " + mins + " minute" + (mins === 1 ? "" : "s") + " left.";
        }
      }
    }
  };

  // ------------------------------
  // Remote config (viewer-config from LOF Extras)
  // ------------------------------

  let remoteConfig = null;
  let remoteConfigLoaded = false;

  function loadViewerConfigFromREST() {
    if (remoteConfigLoaded) return;
    if (typeof fetch !== "function") {
      remoteConfigLoaded = true;
      return;
    }

    fetch("/wp-json/lof-extras/v1/viewer-config", {
      method: "GET",
      credentials: "same-origin"
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        remoteConfig = data || null;
        remoteConfigLoaded = true;
        if (typeof window !== "undefined" && window.console && console.log) {
          console.log("[LOF Epic Viewer] viewer-config loaded", data);
        }
      })
      .catch(function (err) {
        remoteConfigLoaded = true;
        if (typeof window !== "undefined" && window.console && console.warn) {
          console.warn("[LOF Epic Viewer] Failed to load viewer-config:", err);
        }
      });
  }

  function getEffectiveConfig() {
    // Start with the local defaults
    const cfg = LOF_VIEWER_CONFIG;

    // If the REST config has showtimes, override local showWindows
    if (remoteConfig && Array.isArray(remoteConfig.showtimes)) {
      const mapped = [];

      for (let i = 0; i < remoteConfig.showtimes.length; i++) {
        const win = remoteConfig.showtimes[i];
        if (!win || typeof win !== "object") continue;

        const start = (win.start || "").trim();
        const end = (win.end || "").trim();
        if (!start || !end) continue;

        mapped.push({ start: start, end: end });
      }

      if (mapped.length) {
        cfg.showWindows = mapped;
      }
    }

    return cfg;
  }

  // ------------------------------
  // Time helpers
  // ------------------------------

  function parseTimeToMinutes(timeStr) {
    if (!timeStr || typeof timeStr !== "string") return null;
    const parts = timeStr.split(":");
    if (parts.length < 2) return null;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  }

  function getMinutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  function getNextShowWindow(config, nowMinutes) {
    const rawWindows = (config && config.showWindows) || [];

    const windows = rawWindows
      .map(function (w) {
        if (!w) return null;
        const start = parseTimeToMinutes(w.start);
        const end = parseTimeToMinutes(w.end);
        if (start === null || end === null) return null;
        return { start: start, end: end };
      })
      .filter(Boolean);

    if (!windows.length) return null;

    let current = null;
    let next = null;
    let minDiff = Infinity;

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];

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

    return { current: current, next: next };
  }

  // ------------------------------
  // RF mode reader (from DOM)
  // ------------------------------

  function getRFMode() {
    const el = document.getElementById("rf-mode-value");
    if (!el) return null;
    const raw = (el.textContent || "").trim().toUpperCase();
    if (!raw) return null;

    if (raw.indexOf("SHOW") !== -1) return "SHOW";
    if (raw.indexOf("INTERACTIVE") !== -1) return "INTERACTIVE";
    if (raw.indexOf("IDLE") !== -1) return "IDLE";
    if (raw.indexOf("OFF") !== -1) return "OFF";

    return raw;
  }

  // ------------------------------
  // Speaker helpers
  // ------------------------------

  function formatMMSS(seconds) {
    const sec = typeof seconds === "number" && seconds > 0 ? Math.floor(seconds) : 0;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    let label;
    if (m > 0) {
      label = m + ":" + (s < 10 ? "0" + s : s);
    } else {
      label = "0:" + (s < 10 ? "0" + s : s);
    }
    return { m: m, s: s, label: label };
  }

  function getSpeakerEndpoint() {
    // lof-speaker.php lives in the integrations theme
    return window.location.origin + "/wp-content/themes/integrations/lof-speaker.php?action=status";
  }

  function fetchSpeakerStatus() {
    const url = getSpeakerEndpoint();
    return fetch(url, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .catch(function () {
        // Fail quietly; we'll just not show status this tick
        return null;
      });
  }

  function updateSpeakerIndicator(data) {
    const el = document.getElementById("lof-speaker-indicator");
    if (!el) return;

    const cfg = getEffectiveConfig();
    const texts = (cfg.text && cfg.text.speaker) || {};

    if (!data || data.success !== true) {
      el.textContent = "";
      el.classList.remove("lof-speaker-indicator--on", "lof-speaker-indicator--off");
      return;
    }

    const on = !!data.speakerOn;
    const rem = typeof data.remainingSeconds === "number" ? data.remainingSeconds : 0;
    const mm = formatMMSS(rem);

    if (!on) {
      el.textContent = texts.off || "";
      el.classList.add("lof-speaker-indicator--off");
      el.classList.remove("lof-speaker-indicator--on");
      return;
    }

    // Speaker ON
    let line = "";
    if (rem > 0 && typeof texts.onWithTime === "function") {
      line = texts.onWithTime(mm.m, rem);
    } else if (texts.onNoTime) {
      line = texts.onNoTime;
    }

    if (!line) {
      line = "Sound is ON near the show.";
    }

    el.textContent = line;
    el.classList.add("lof-speaker-indicator--on");
    el.classList.remove("lof-speaker-indicator--off");
  }

  function pollSpeakerStatus() {
    fetchSpeakerStatus().then(function (data) {
      updateSpeakerIndicator(data);
    });
  }

  // ------------------------------
  // DOM helpers
  // ------------------------------

  function setText(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || "";
  }

  function setCountdownText(minutesUntil) {
    const el = document.getElementById("lof-show-countdown");
    if (!el) return;

    if (minutesUntil == null || minutesUntil <= 0) {
      el.textContent = "";
      el.style.display = "none";
      return;
    }

    el.style.display = "block";

    if (minutesUntil < 1) {
      el.textContent = "Next show starts in under a minute.";
    } else if (minutesUntil === 1) {
      el.textContent = "Next show starts in about 1 minute.";
    } else {
      el.textContent = "Next show starts in about " + minutesUntil + " minutes.";
    }
  }

  // ------------------------------
  // Banner logic
  // ------------------------------

  function updateEpicBanner() {
    const root = document.getElementById("lof-epic-banner");
    if (!root) return;

    const now = new Date();
    const nowMin = getMinutesSinceMidnight(now);
    const mode = getRFMode();
    const cfg = getEffectiveConfig();
    const windows = getNextShowWindow(cfg, nowMin);

    const texts = cfg.text || {};
    let kicker;
    let title;
    let body;
    let minutesUntilNext = null;

    const inShowWindow = windows && windows.current;

    if (inShowWindow) {
      kicker = texts.showtime && texts.showtime.kicker;
      title = texts.showtime && texts.showtime.title;
      body = texts.showtime && texts.showtime.body;
    } else {
      if (windows && windows.next) {
        minutesUntilNext = windows.next.start - nowMin;
      }

      if (
        minutesUntilNext != null &&
        minutesUntilNext > 0 &&
        minutesUntilNext <= cfg.countdownThresholdMinutes
      ) {
        kicker = texts.adhoc && texts.adhoc.kicker;
        title = texts.adhoc && texts.adhoc.title;
        body = texts.adhoc && texts.adhoc.body;
      } else {
        kicker = texts.offline && texts.offline.kicker;
        title = texts.offline && texts.offline.title;
        body = texts.offline && texts.offline.body;
      }
    }

    // Refine message based on RF mode, if we know it
    if (mode === "OFF") {
      kicker = texts.offline && texts.offline.kicker;
      title = texts.offline && texts.offline.title;
      body = texts.offline && texts.offline.body;
    } else if (mode === "INTERACTIVE") {
      kicker = texts.adhoc && texts.adhoc.kicker;
      title = texts.adhoc && texts.adhoc.title;
      body = texts.adhoc && texts.adhoc.body;
    } else if (mode === "SHOW") {
      kicker = texts.showtime && texts.showtime.kicker;
      title = texts.showtime && texts.showtime.title;
      body = texts.showtime && texts.showtime.body;
    }

    setText("lof-banner-kicker", kicker || "");
    setText("lof-banner-title", title || "");
    setText("lof-banner-body", body || "");

    if (
      minutesUntilNext != null &&
      minutesUntilNext > 0 &&
      minutesUntilNext <= cfg.countdownThresholdMinutes
    ) {
      setCountdownText(minutesUntilNext);
    } else {
      setCountdownText(null);
    }
  }

  // ------------------------------
  // Init
  // ------------------------------

  function initEpicViewer() {
    loadViewerConfigFromREST();
    updateEpicBanner();
    pollSpeakerStatus();

    // Poll banner state (showtime/ad-hoc) every 30s
    setInterval(updateEpicBanner, 30000);

    // Poll speaker status more frequently
    const intervalMs = Math.max(3, LOF_VIEWER_CONFIG.speakerPollSeconds || 5) * 1000;
    setInterval(pollSpeakerStatus, intervalMs);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initEpicViewer);
  } else {
    initEpicViewer();
  }
})();
