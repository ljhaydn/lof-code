/**
 * Lights On Falcon — Epic Viewer vNEXT (Cinematic Edition)
 * This file replaces: /themes/integrations/js/lof-epic-viewer.js
 *
 * Responsibilities:
 * - Phase Engine (Showtime, Intermission, Drop-By, Off-Season, etc.)
 * - Persona Engine v3 (XP, levels, streaks, badges, achievements)
 * - Vibe Engine v3 (energy scoring, multi-event inputs)
 * - Tonight Panel Engine (reactive: persona + vibe + show)
 * - Theme Loader (season + phase → dynamic tokens)
 * - RF Integration Enhancements (events, cues, cooldowns)
 * - Micro Interactions & Season Delight (toasts, pulses, easter egg hooks)
 * - Fail-soft FPP + RF handling
 */

// -------------------------------------------
// GLOBAL STATE
// -------------------------------------------

const LOF = {
    config: null,              // viewer-config from backend (text, season, etc.)
    show: null,                // /show-status result
    phase: "loading",          // current show phase
    lastPhase: null,           // previous phase
    persona: null,             // persona engine instance
    vibe: null,                // vibe engine instance
    tonight: null,             // tonight panel engine instance
    eggs: null,                // easter egg engine instance

    rf: {                      // remote falcon reactive state
        mode: null,            // jukebox / voting / disabled (if we wire RF)
        queue: [],
        nowPlaying: null,
        cooldown: false,
        lastPickAt: null
    },

    timers: {
        statusPoll: null,
        vibeTick: null
    },

    ui: {},                    // DOM refs
    debug: false               // set true to log
};

// Quick logger
function lofLog(...args) {
    if (LOF.debug) console.log("%c[LOF]", "color:#7f5eff;font-weight:bold;", ...args);
}

// -------------------------------------------
// DOM READY HELPER
// -------------------------------------------
function lofReady(fn) {
    if (document.readyState !== "loading") return fn();
    document.addEventListener("DOMContentLoaded", fn);
}

// -------------------------------------------
// LOCAL STORAGE WRAPPER
// -------------------------------------------
const store = {
    get(key, fallback = null) {
        try {
            const v = localStorage.getItem(key);
            return v ? JSON.parse(v) : fallback;
        } catch (e) { return fallback; }
    },
    set(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
    }
};

// -------------------------------------------
// INITIALIZE EVERYTHING
// -------------------------------------------

lofReady(() => {
    lofLog("Epic Viewer vNEXT — bootstrapping…");

    initializeUIRefs();

    LOF.persona = PersonaEngine();
    LOF.vibe    = VibeEngine();
    LOF.tonight = TonightPanelEngine();
    LOF.eggs    = EasterEggEngine();

    fetchViewerConfig().then(() => {
        applyInitialTheme();
        startShowStatusPolling();
        startVibeTicking();
        hookRemoteFalconEvents();
        hookRFCardClicks(); // local click glue in case RF doesn’t emit custom events
        LOF.tonight.updateAll(); // initial render
        LOF.eggs.checkInitial();
    });
});

// -------------------------------------------
// Fetch viewer-config from LOF Extras API
// -------------------------------------------
async function fetchViewerConfig() {
    try {
        const res = await fetch('/wp-json/lof-extras/v1/viewer-config');
        if (!res.ok) throw new Error("viewer-config HTTP " + res.status);
        const json = await res.json();
        LOF.config = json || {};
        lofLog("Config loaded:", LOF.config);
    } catch (err) {
        lofLog("Config fetch failed:", err);
        LOF.config = {};
    }
}

// -------------------------------------------
// Poll /show-status every 5s
// -------------------------------------------
function startShowStatusPolling() {
    updateShowStatus();
    LOF.timers.statusPoll = setInterval(updateShowStatus, 5000);
}

async function updateShowStatus() {
    try {
        const res = await fetch('/wp-json/lof-extras/v1/show-status');
        if (!res.ok) throw new Error("show-status HTTP " + res.status);
        const json = await res.json();
        if (!json || !json.show) throw new Error("Invalid show-status payload");

        LOF.show = json.show;
        updatePhase(json.show.phase);
        LOF.tonight.updateAll();
        LOF.eggs.checkOnStatus();
    } catch (err) {
        lofLog("Show-status fetch failed:", err);
        updatePhase("maintenance");
    }
}

// -------------------------------------------
// PHASE ENGINE — The heart of the UX
// -------------------------------------------

function updatePhase(newPhase) {
    if (!newPhase) newPhase = "off_hours";
    if (LOF.phase === newPhase) return; // no-op if unchanged

    LOF.lastPhase = LOF.phase;
    LOF.phase = newPhase;
    lofLog("Phase change:", LOF.lastPhase, "→", LOF.phase);

    document.documentElement.setAttribute("data-lof-phase", LOF.phase);

    // Clear phase body classes
    document.body.classList.remove(
        "lof-phase-showtime",
        "lof-phase-intermission",
        "lof-phase-dropby",
        "lof-phase-preshow",
        "lof-phase-aftershow",
        "lof-phase-offhours",
        "lof-phase-offseason",
        "lof-phase-maintenance"
    );

    switch (newPhase) {
        case "showtime":
        case "force_showtime":
            showShowtimeUI();
            LOF.persona.addXP(5, "phase_showtime");
            LOF.eggs.trigger("showtime");
            break;

        case "intermission":
        case "force_intermission":
            showIntermissionUI();
            LOF.persona.addXP(2, "phase_intermission");
            LOF.eggs.trigger("intermission");
            break;

        case "drop_by":
        case "force_drop_by":
            showDropByUI();
            LOF.persona.addXP(1, "phase_dropby");
            LOF.eggs.trigger("dropby");
            break;

        case "pre_show":
        case "force_pre_show":
            showPreShowUI();
            LOF.eggs.trigger("preshow");
            break;

        case "after_show":
        case "force_after_show":
            showAfterShowUI();
            LOF.eggs.trigger("aftershow");
            break;

        case "off_hours":
        case "force_off_hours":
            showOffHoursUI();
            LOF.eggs.trigger("offhours");
            break;

        case "off_season":
        case "force_off_season":
            showOffSeasonUI();
            LOF.eggs.trigger("offseason");
            break;

        case "maintenance":
        case "force_maintenance":
        default:
            showMaintenanceUI();
            LOF.eggs.trigger("maintenance");
            break;
    }

    // Soft bump to vibe when phase changes
    LOF.vibe.bump(1, "phase_change");
    LOF.tonight.updateAll();
}

// -------------------------------------------
// PHASE UI HANDLERS
// -------------------------------------------

function showShowtimeUI() {
    updateBanner(LOF.config?.text?.banner_showtime || "It’s showtime ✨");
    enableRFControls(true);
    setGridActive(true);
    document.body.classList.add("lof-phase-showtime");
}

function showIntermissionUI() {
    updateBanner(LOF.config?.text?.banner_intermission || "Intermission — quick breather 💨");
    enableRFControls(false);
    setGridActive(false);
    document.body.classList.add("lof-phase-intermission");
}

function showDropByUI() {
    updateBanner(LOF.config?.text?.banner_dropby || "Drop-by mode — you’re early, but the magic’s warming up.");
    enableRFControls(true);
    setGridActive(true);
    document.body.classList.add("lof-phase-dropby");
}

function showPreShowUI() {
    updateBanner(LOF.config?.text?.banner_preshow || "Pre-show — lights stretching, neighbors gathering.");
    enableRFControls(false);
    setGridActive(false);
    document.body.classList.add("lof-phase-preshow");
}

function showAfterShowUI() {
    updateBanner(LOF.config?.text?.banner_aftershow || "Show’s wrapped — thanks for bringing the glow 💚");
    enableRFControls(false);
    setGridActive(false);
    document.body.classList.add("lof-phase-aftershow");
}

function showOffHoursUI() {
    updateBanner(LOF.config?.text?.banner_offhours || "Off-hours — Falcon is resting up for the next show.");
    enableRFControls(false);
    setGridActive(false);
    document.body.classList.add("lof-phase-offhours");
}

function showOffSeasonUI() {
    updateBanner(LOF.config?.text?.banner_offseason || "Off-season — we’re recharging and plotting what’s next.");
    enableRFControls(false);
    setGridActive(false);
    document.body.classList.add("lof-phase-offseason");
}

function showMaintenanceUI() {
    updateBanner(LOF.config?.text?.banner_maintenance || "Maintenance moment — the elves are rewiring behind the scenes.");
    enableRFControls(false);
    setGridActive(false);
    document.body.classList.add("lof-phase-maintenance");
}

// -------------------------------------------
// BANNER ENGINE
// -------------------------------------------

function updateBanner(text) {
    const el = LOF.ui.banner;
    if (!el) return;

    el.innerHTML = text || "";
    el.classList.remove("lof-banner-pulse");
    // Trigger a reflow so animation restarts
    void el.offsetWidth;
    el.classList.add("lof-banner-pulse");
}

// -------------------------------------------
// UI REFS
// -------------------------------------------

function initializeUIRefs() {
    LOF.ui.banner        = document.querySelector(".lof-banner");
    LOF.ui.grid          = document.querySelector("#rf-grid");
    LOF.ui.vibeMeter     = document.querySelector(".lof-vibe-meter");
    LOF.ui.personaTitle  = document.querySelector(".lof-persona-title");
    LOF.ui.personaBadge  = document.querySelector(".lof-persona-badge");
    LOF.ui.personaStreak = document.querySelector(".lof-persona-streak");
    LOF.ui.tonightRoot   = document.querySelector(".lof-tonight");
    LOF.ui.tonightVibe   = document.querySelector(".lof-tonight-vibe");
    LOF.ui.tonightStats  = document.querySelector(".lof-tonight-stats");
}

// -------------------------------------------
// REMOTE FALCON CONTROL MANAGEMENT
// -------------------------------------------

function enableRFControls(enabled) {
    const cards = document.querySelectorAll(".rf-card");

    cards.forEach(card => {
        if (enabled) {
            card.classList.remove("rf-disabled");
            card.removeAttribute("aria-disabled");
        } else {
            card.classList.add("rf-disabled");
            card.setAttribute("aria-disabled", "true");
        }
    });
}

function setGridActive(active) {
    if (!LOF.ui.grid) return;
    LOF.ui.grid.setAttribute("data-grid-active", active ? "1" : "0");
}

// -------------------------------------------
// PERSONA ENGINE (v3)
// -------------------------------------------

function PersonaEngine() {

    let data = store.get("lof_persona", {
        xp: 0,
        level: 1,
        title: "New Neighbor",
        badges: [],
        streakDays: 0,
        lastVisit: null,
        totalRequests: 0,
        totalGlows: 0,
        easterEggs: []
    });

    const titles = [
        "New Neighbor",        // 1
        "Returning Neighbor",  // 2
        "Chaos Rookie",        // 3
        "Falcon Regular",      // 4
        "Chaos Captain",       // 5
        "Midnight Mayor"       // 6
    ];

    function save() { store.set("lof_persona", data); }

    function addXP(amount, reason) {
        if (!amount || amount === 0) return;
        data.xp += amount;

        const newLevel = Math.min(6, Math.floor(data.xp / 40) + 1); // slower leveling
        if (newLevel !== data.level) {
            data.level = newLevel;
            data.title = titles[newLevel - 1];
            save();
            showPersonaToast(`You leveled up to ${data.title}!`);
            updatePersonaUI();
        } else {
            save();
        }
    }

    function recordVisit() {
        const today = new Date().toISOString().slice(0,10);
        if (data.lastVisit !== today) {
            data.lastVisit = today;
            data.streakDays += 1;
            // Small XP nudge for streak
            addXP(1, "visit_streak");
        }
        save();
        updatePersonaUI();
    }

    function recordRequest() {
        data.totalRequests += 1;
        addXP(3, "song_request");
        save();
        maybeGrantBadge("request_3", data.totalRequests >= 3, "3 Requests Club");
        maybeGrantBadge("request_10", data.totalRequests >= 10, "Playlist Co-Pilot");
    }

    function recordGlow() {
        data.totalGlows += 1;
        addXP(2, "glow");
        save();
        maybeGrantBadge("glow_5", data.totalGlows >= 5, "Neighborhood Hype Squad");
    }

    function maybeGrantBadge(id, condition, label) {
        if (!condition) return;
        if (data.badges.includes(id)) return;
        data.badges.push(id);
        save();
        showPersonaToast(`New badge unlocked: ${label}`);
    }

    function addEasterEgg(id) {
        if (!data.easterEggs.includes(id)) {
            data.easterEggs.push(id);
            save();
        }
    }

    function updatePersonaUI() {
        if (LOF.ui.personaTitle) {
            LOF.ui.personaTitle.textContent = data.title;
        }
        if (LOF.ui.personaBadge) {
            LOF.ui.personaBadge.textContent = `${data.badges.length} badge${data.badges.length === 1 ? '' : 's'}`;
        }
        if (LOF.ui.personaStreak) {
            LOF.ui.personaStreak.textContent = `${data.streakDays} night${data.streakDays === 1 ? '' : 's'} this season`;
        }
    }

    function showPersonaToast(msg) {
        lofToast(msg);
    }

    // On first load, sync UI + register visit
    lofReady(() => {
        recordVisit();
        updatePersonaUI();
    });

    return {
        addXP,
        recordVisit,
        recordRequest,
        recordGlow,
        addEasterEgg,
        get: () => data
    };
}

// -------------------------------------------
// VIBE ENGINE (v3)
// -------------------------------------------

function VibeEngine() {

    let score = 0;
    let events = {
        requests: 0,
        glows: 0,
        neighbors: 1
    };

    function bump(val, source) {
        // basic bump
        score = Math.min(100, score + (val || 1));

        // record extra events
        if (source === "song_request") events.requests++;
        if (source === "glow") events.glows++;

        updateVibeUI();
    }

    function decay() {
        score = Math.max(0, score - 1);
        updateVibeUI();
    }

    function vibeState() {
        if (score > 80) return "peak";   // absolute chaos
        if (score > 60) return "warm";   // strong energy
        if (score > 30) return "cozy";   // mellow but alive
        return "low";                    // calm
    }

    function updateVibeUI() {
        const state = vibeState();
        document.documentElement.setAttribute("data-vibe", state);

        if (LOF.ui.vibeMeter) {
            LOF.ui.vibeMeter.setAttribute("data-vibe", state);
            LOF.ui.vibeMeter.style.setProperty("--lof-vibe-score", score);
            LOF.ui.vibeMeter.textContent = state === "peak"
                ? "Peak Falcon Energy"
                : state === "warm"
                ? "Warming Up Nicely"
                : state === "cozy"
                ? "Cozy Neighborhood Glow"
                : "Soft & Quiet";
        }

        // Let TonightPanel know vibe changed
        if (LOF.tonight) LOF.tonight.updateVibe(state, score, events);
    }

    return {
        bump,
        decay,
        state: () => vibeState(),
        getScore: () => score,
        getEvents: () => events
    };
}

function startVibeTicking() {
    if (LOF.timers.vibeTick) clearInterval(LOF.timers.vibeTick);
    LOF.timers.vibeTick = setInterval(() => LOF.vibe.decay(), 8000);
}

// -------------------------------------------
// TONIGHT PANEL ENGINE
// -------------------------------------------

function TonightPanelEngine() {

    function updateAll() {
        if (!LOF.ui.tonightRoot) return;

        updateHeadline();
        updateStats();
        updateVibeBlock();
    }

    function updateHeadline() {
        if (!LOF.ui.tonightRoot) return;
        const persona = LOF.persona.get();
        const phase = LOF.phase;

        let line = "Tonight at Lights on Falcon";
        if (phase === "showtime") {
            line = `Tonight at Lights on Falcon — you’re part of the show, ${persona.title}.`;
        } else if (phase === "intermission") {
            line = `Intermission vibes — stretch, sip, and stay glowing, ${persona.title}.`;
        } else if (phase === "drop_by") {
            line = `Drop-by mode — you found us early, ${persona.title}.`;
        } else if (phase === "off_hours" || phase === "off_season") {
            line = `Falcon’s resting, but the story keeps going.`;
        }

        const hl = LOF.ui.tonightRoot.querySelector(".lof-tonight-headline");
        if (hl) hl.textContent = line;
    }

    function updateStats() {
        if (!LOF.ui.tonightStats) return;

        const persona = LOF.persona.get();
        const show = LOF.show || {};
        const playlist = show.playlist || "—";

        const bits = [];

        bits.push(`Level: ${persona.level} (${persona.title})`);
        bits.push(`Requests from this device: ${persona.totalRequests}`);
        bits.push(`Glows you’ve sent: ${persona.totalGlows}`);
        bits.push(`Nights this season: ${persona.streakDays}`);
        bits.push(`Current playlist: ${playlist}`);

        LOF.ui.tonightStats.innerHTML = bits.map(b => `<div class="lof-tonight-stat-line">${b}</div>`).join("");
    }

    function updateVibe(state, score, ev) {
        if (!LOF.ui.tonightVibe) return;

        let label;
        if (state === "peak") label = "Neighborhood is absolutely lit 🔥";
        else if (state === "warm") label = "Energy is high, keep it going ✨";
        else if (state === "cozy") label = "Soft glow, easy vibes 🌙";
        else label = "Quiet moment — your glow still matters 💚";

        LOF.ui.tonightVibe.innerHTML = `
            <div class="lof-tonight-vibe-label">${label}</div>
            <div class="lof-tonight-vibe-meta">
                <span>Vibe score: ${score}</span>
                <span>Requests this session: ${ev.requests}</span>
                <span>Glows this session: ${ev.glows}</span>
            </div>
        `;
    }

    return {
        updateAll,
        updateVibe
    };
}

// -------------------------------------------
// THEME LOADER
// -------------------------------------------

function applyInitialTheme() {
    const season = LOF.config?.season || "default";
    document.documentElement.setAttribute("data-season", season);
}

// -------------------------------------------
// EASTER EGG ENGINE
// -------------------------------------------

function EasterEggEngine() {

    const eggs = {
        // Example eggs:
        // 'late_night_showtime': triggered if showtime after 22:00
        // 'first_dropby': first time hitting dropby
    };

    function checkInitial() {
        // Example: if first time ever visiting
        const persona = LOF.persona.get();
        if (persona.streakDays === 1 && persona.totalRequests === 0) {
            // subtle nudge
            lofLog("First visit this season — subtle easter egg hook.");
        }
    }

    function checkOnStatus() {
        // Could use LOF.show, LOF.phase, etc.
        if (!LOF.show) return;

        // Example: late-night showtime achievement
        if (LOF.phase === "showtime") {
            const now = new Date();
            const hour = now.getHours();
            if (hour >= 22) {
                triggerEgg("late_night_showtime", "Night Owl: You caught the late show.");
            }
        }
    }

    function trigger(phaseKey) {
        // This can be extended with more complex patterns.
        if (phaseKey === "dropby") {
            triggerEgg("first_dropby", "You found us early — Drop-By Explorer.");
        }
    }

    function triggerEgg(id, label) {
        const persona = LOF.persona.get();
        if (persona.easterEggs && persona.easterEggs.includes(id)) return;
        LOF.persona.addEasterEgg(id);
        if (label) lofToast(label);
    }

    return {
        checkInitial,
        checkOnStatus,
        trigger
    };
}

// -------------------------------------------
// REMOTE FALCON HOOKS (EVENT GLUE)
// -------------------------------------------

function hookRemoteFalconEvents() {

    // Now Playing event (custom event expected from rf-viewer.js integration)
    document.addEventListener("rf-nowplaying", (ev) => {
        LOF.rf.nowPlaying = ev.detail;
        LOF.vibe.bump(1, "nowplaying");
    });

    // Queue update (song added / removed)
    document.addEventListener("rf-queue-update", (ev) => {
        LOF.rf.queue = ev.detail.queue || [];
        LOF.vibe.bump(1, "queue");
    });

    // Song picked by this viewer (we also emit this locally on card click)
    document.addEventListener("rf-song-picked", (ev) => {
        LOF.rf.lastPickAt = Date.now();
        LOF.persona.recordRequest();
        LOF.vibe.bump(3, "song_request");
        lofToast("Request locked in. Nice pick. 🎶");
    });

    // Glow sent (if Glow UI emits this custom event)
    document.addEventListener("lof-glow-sent", (ev) => {
        LOF.persona.recordGlow();
        LOF.vibe.bump(2, "glow");
        lofToast("Glow sent. Thanks for lighting someone’s night. 💚");
    });

    // Cooldown event (RF request throttle)
    document.addEventListener("rf-cooldown", () => {
        LOF.rf.cooldown = true;
        lofToast("Take a breather, you’ve hit the request cooldown.");
        setTimeout(() => { LOF.rf.cooldown = false; }, 15000);
    });
}

// Local click hook to generate rf-song-picked when RF doesn't emit it natively
function hookRFCardClicks() {
    document.addEventListener("click", (ev) => {
        const card = ev.target.closest(".rf-card");
        if (!card) return;
        if (card.classList.contains("rf-disabled")) return;

        // Fire synthetic event that other parts of system can listen to
        const evt = new CustomEvent("rf-song-picked", {
            detail: {
                id: card.getAttribute("data-id") || null
            }
        });
        document.dispatchEvent(evt);
    });
}

// -------------------------------------------
// TOAST UTILITY
// -------------------------------------------

function lofToast(msg) {
    const n = document.createElement("div");
    n.className = "lof-toast";
    n.textContent = msg;
    document.body.appendChild(n);
    requestAnimationFrame(() => {
        n.classList.add("lof-toast-in");
    });
    setTimeout(() => {
        n.classList.remove("lof-toast-in");
        n.classList.add("lof-toast-out");
        setTimeout(() => n.remove(), 300);
    }, 2500);
}
