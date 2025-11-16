(function () {
  // ------------------------------
  // CONFIG – local defaults
  // ------------------------------

  const LOF_VIEWER_CONFIG = {
    // Fallback showtime windows (24h) – overridden by viewer-config
    showWindows: [
      { start: "17:00", end: "22:00" } // 5pm–10pm
    ],

    // Within this many minutes of next show, show a countdown
    countdownThresholdMinutes: 60,

    // How often to refresh speaker status (seconds)
    speakerPollSeconds: 5,

    // How often to refresh FPP show status (seconds)
    fppPollSeconds: 15,

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

  const PERSONA_STORAGE_KEY = "lofViewerPersona";

  // ------------------------------
  // Remote config (viewer-config)
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
        if (window.console && console.log) {
          console.log("[LOF Epic Viewer] viewer-config loaded", data);
        }
      })
      .catch(function (err) {
        remoteConfigLoaded = true;
        if (window.console && console.warn) {
          console.warn("[LOF Epic Viewer] Failed to load viewer-config:", err);
        }
      });
  }

  function getEffectiveConfig() {
    const cfg = LOF_VIEWER_CONFIG;

    // Show windows from remoteConfig.showtimes
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

    // Later we can wire cfg.text.showtime/adhoc/offline from remoteConfig.copy if desired

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

  function getSpeakerStatusEndpoint() {
    return window.location.origin + "/wp-content/themes/integrations/lof-speaker.php?action=status";
  }

  function fetchSpeakerStatus() {
    const url = getSpeakerStatusEndpoint();
    return fetch(url, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .catch(function () {
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
  // FPP show-status helpers
  // ------------------------------

  let fppState = {
    isPlaying: null,
    mode: null,
    playlist: null,
    lastUpdated: null
  };

  function getFppStatusEndpoint() {
    return window.location.origin + "/wp-content/themes/integrations/lof-speaker.php?action=showstatus";
  }

  function fetchFppStatus() {
    const url = getFppStatusEndpoint();
    return fetch(url, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || typeof data !== "object") return null;
        fppState.isPlaying = !!data.isPlaying;
        fppState.mode = data.mode || null;
        fppState.playlist = data.playlist || null;
        fppState.lastUpdated = new Date();
        return data;
      })
      .catch(function () {
        return null;
      });
  }

  function pollFppStatus() {
    fetchFppStatus();
  }

  // ------------------------------
  // Persona / badge helpers
  // ------------------------------

  let personaState = null;

  function loadPersona() {
    if (personaState) return personaState;

    let base = {
      firstVisit: null,
      lastVisit: null,
      visitCount: 0,
      totalInteractions: 0 // roughly "requests/votes" via card button clicks
    };

    try {
      if (typeof window.localStorage === "undefined") {
        personaState = base;
        return base;
      }
      const raw = window.localStorage.getItem(PERSONA_STORAGE_KEY);
      if (!raw) {
        personaState = base;
        return base;
      }
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        base = Object.assign(base, parsed);
      }
    } catch (e) {
      // ignore
    }
    personaState = base;
    return base;
  }

  function savePersona() {
    if (!personaState) return;
    try {
      if (typeof window.localStorage === "undefined") return;
      window.localStorage.setItem(PERSONA_STORAGE_KEY, JSON.stringify(personaState));
    } catch (e) {
      // ignore
    }
  }

  function touchVisit() {
    const now = Date.now();
    const p = loadPersona();
    if (!p.firstVisit) {
      p.firstVisit = now;
    }
    p.lastVisit = now;
    p.visitCount = (p.visitCount || 0) + 1;
    personaState = p;
    savePersona();
  }

  function recordInteraction() {
    const p = loadPersona();
    p.totalInteractions = (p.totalInteractions || 0) + 1;
    personaState = p;
    savePersona();
  }

  function getPersonaSummary() {
    const p = loadPersona();
    const visits = p.visitCount || 0;
    const actions = p.totalInteractions || 0;

    let title = "";
    let detail = "";

    if (visits <= 1) {
      title = "First time at Falcon 💫";
      detail = actions > 0
        ? "You’re already poking at the controls. Respect."
        : "Take your time, explore the chaos. The lights are friendly.";
    } else if (visits <= 5) {
      title = "Returning neighbor 👋";
      detail = actions >= 3
        ? "You’ve already helped steer the show multiple times."
        : "You know the drill. Pick a favorite or let Surprise Me do the work.";
    } else {
      title = "Regular on the block 🌈";
      if (actions >= 10) {
        detail = "Chaos captain: you’ve been nudging the playlist all season.";
      } else if (actions >= 3) {
        detail = "You’ve shaped the soundtrack more than once. Keep going.";
      } else {
        detail = "Thanks for coming back again. The lights missed you.";
      }
    }

    // Little extra nod for 3+ interactions milestone
    let badge = null;
    if (actions >= 3 && actions < 10) {
      badge = "Song selector (3+ picks)";
    } else if (actions >= 10) {
      badge = "Chaos captain (10+ picks)";
    }

    return { title: title, detail: detail, badge: badge };
  }

  function getPersonaRoot() {
    let root = document.getElementById("lof-persona-badge");
    if (root) return root;

    const banner = document.getElementById("lof-epic-banner");
    root = document.createElement("div");
    root.id = "lof-persona-badge";
    root.className = "lof-persona-badge";

    // Keep it visually tied to the epic banner if possible
    if (banner && banner.parentNode) {
      banner.parentNode.insertBefore(root, banner.nextSibling);
    } else {
      document.body.appendChild(root);
    }

    const label = document.createElement("div");
    label.className = "lof-persona-title";
    root.appendChild(label);

    const detail = document.createElement("div");
    detail.className = "lof-persona-detail";
    root.appendChild(detail);

    const badge = document.createElement("div");
    badge.className = "lof-persona-chip";
    root.appendChild(badge);

    return root;
  }

  function updatePersonaUI() {
    const root = getPersonaRoot();
    const summary = getPersonaSummary();

    const titleEl = root.querySelector(".lof-persona-title");
    const detailEl = root.querySelector(".lof-persona-detail");
    const chipEl = root.querySelector(".lof-persona-chip");

    if (titleEl) titleEl.textContent = summary.title || "";
    if (detailEl) detailEl.textContent = summary.detail || "";

    if (summary.badge) {
      chipEl.textContent = summary.badge;
      chipEl.style.display = "inline-flex";
    } else {
      chipEl.textContent = "";
      chipEl.style.display = "none";
    }
  }

  function initPersonaListeners() {
    const grid = document.getElementById("rf-grid");
    if (!grid) return;

    // Delegate clicks on RF card buttons as "interactions" (requests/votes)
    grid.addEventListener("click", function (evt) {
      if (!evt.target) return;
      const btn = evt.target.closest(".rf-card-btn");
      if (!btn) return;
      recordInteraction();
      updatePersonaUI();
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
  // Banner logic (schedule + RF mode + FPP state)
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

    // Layer 2: FPP truth (if we know it)
    const fppKnown = typeof fppState.isPlaying === "boolean";
    const fppPlaying = fppKnown && fppState.isPlaying;

    if (fppKnown) {
      if (!fppPlaying) {
        // FPP says we're not playing anything – treat as offline, even in a window
        kicker = texts.offline && texts.offline.kicker;
        title = texts.offline && texts.offline.title;
        body = texts.offline && texts.offline.body;
        minutesUntilNext = minutesUntilNext; // unchanged
      } else {
        // FPP is actively playing – treat as showtime regardless of the static window
        kicker = texts.showtime && texts.showtime.kicker;
        title = texts.showtime && texts.showtime.title;
        body = texts.showtime && texts.showtime.body;
        minutesUntilNext = null; // you’re already in the thick of it
      }
    }

    // Layer 3: RF mode nuance (only if FPP state is unknown)
    if (!fppKnown && mode) {
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

    // Personas: track visit & wire up request/vote clicks
    touchVisit();
    updatePersonaUI();
    initPersonaListeners();

    // Initial pulls
    updateEpicBanner();
    pollSpeakerStatus();
    pollFppStatus();

    // Poll banner state (showtime/ad-hoc) every 30s
    setInterval(updateEpicBanner, 30000);

    // Poll speaker status more frequently
    const speakerIntervalMs = Math.max(3, LOF_VIEWER_CONFIG.speakerPollSeconds || 5) * 1000;
    setInterval(pollSpeakerStatus, speakerIntervalMs);

    // Poll FPP show status
    const fppIntervalMs = Math.max(5, LOF_VIEWER_CONFIG.fppPollSeconds || 15) * 1000;
    setInterval(pollFppStatus, fppIntervalMs);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initEpicViewer);
  } else {
    initEpicViewer();
  }
})();
