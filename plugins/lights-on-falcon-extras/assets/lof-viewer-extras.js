(function () {
  if (typeof LOF_EXTRAS === 'undefined') return;

  const cfg = LOF_EXTRAS;
  const texts = cfg.texts || {};
  const stats = cfg.stats || {};
  const rfShowUrl = cfg.rfShowUrl;
  const schedule = cfg.schedule || {};
  const speakerDuration = cfg.speakerDuration || 300;

  let speakerSecondsRemaining = 0;
  let speakerTimer = null;
  let speakerStatusEl = null;

  /* -------------------------
   * Helpers
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

  function createToast() {
    let el = document.getElementById('lof-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lof-toast';
      el.className = 'lof-toast';
      document.body.appendChild(el);
    }
    return el;
  }

  function showToast(message) {
    if (!message) return;
    const el = createToast();
    el.textContent = message;
    el.classList.add('lof-toast--visible');
    setTimeout(() => {
      el.classList.remove('lof-toast--visible');
    }, 3000);
  }

  function formatTemplate(tpl, replacements) {
    let out = String(tpl || '');
    Object.keys(replacements || {}).forEach(key => {
      const rx = new RegExp('\\{' + key + '\\}', 'g');
      out = out.replace(rx, replacements[key]);
    });
    return out;
  }

  function chooseRandomLine(multiline) {
    if (!multiline) return '';
    const parts = String(multiline)
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    if (!parts.length) return '';
    const idx = Math.floor(Math.random() * parts.length);
    return parts[idx];
  }

  function formatSecondsToMinSec(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m <= 0) return `${r}s`;
    return `${m}m ${r.toString().padStart(2, '0')}s`;
  }

  /* -------------------------
   * Showtime vs Drop-by logic
   * ------------------------- */

  function getShowtimeStatus() {
    const startHour = typeof schedule.startHour === 'number' ? schedule.startHour : parseInt(schedule.startHour, 10);
    const endHour = typeof schedule.endHour === 'number' ? schedule.endHour : parseInt(schedule.endHour, 10);

    if (isNaN(startHour) || isNaN(endHour)) {
      return null; // schedule disabled
    }

    const now = new Date();
    const hour = now.getHours();
    const minutes = now.getMinutes();

    const inWindow = hour >= startHour && hour < endHour;

    if (inWindow) {
      // Top-of-hour full show assumption
      if (minutes < 8) {
        return {
          mode: 'showtime_now',
          minutesToNext: 0
        };
      }
      const minutesToNext = 60 - minutes;
      return {
        mode: 'showtime_soon',
        minutesToNext
      };
    }

    // Outside window: next show is at startHour either later today or tomorrow
    let next = new Date(now.getTime());
    next.setSeconds(0);
    next.setMilliseconds(0);

    if (hour < startHour) {
      next.setHours(startHour, 0);
    } else {
      // tomorrow
      next.setDate(next.getDate() + 1);
      next.setHours(startHour, 0);
    }

    const diffMs = next.getTime() - now.getTime();
    const diffMinutes = Math.round(diffMs / 60000);

    return {
      mode: 'adhoc',
      minutesToNext: diffMinutes
    };
  }

  /* -------------------------
   * Speaker state helpers
   * ------------------------- */

  function updateSpeakerStatusUI() {
    if (!speakerStatusEl) return;

    if (speakerSecondsRemaining > 0) {
      const label = `Speaker: On for ~${formatSecondsToMinSec(speakerSecondsRemaining)}`;
      speakerStatusEl.textContent = label;
    } else {
      speakerStatusEl.textContent = 'Speaker: Off (tap to turn on)';
    }
  }

  function startSpeakerCountdown(seconds) {
    speakerSecondsRemaining = Math.max(0, seconds || 0);
    if (speakerTimer) {
      clearInterval(speakerTimer);
      speakerTimer = null;
    }
    updateSpeakerStatusUI();
    if (speakerSecondsRemaining <= 0) return;

    speakerTimer = setInterval(() => {
      speakerSecondsRemaining -= 1;
      if (speakerSecondsRemaining <= 0) {
        speakerSecondsRemaining = 0;
        clearInterval(speakerTimer);
        speakerTimer = null;
      }
      updateSpeakerStatusUI();
    }, 1000);
  }

  async function fetchSpeakerStatus() {
    try {
      const res = await fetch(cfg.restBase + '/speaker/status', {
        method: 'GET'
      });
      if (!res.ok) {
        console.error('[LOF] speaker status error:', res.status);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data && typeof data.secondsRemaining === 'number') {
        startSpeakerCountdown(data.secondsRemaining);
      } else {
        startSpeakerCountdown(0);
      }
    } catch (e) {
      console.error('[LOF] speaker status fetch error:', e);
      // Fallback: just assume off
      startSpeakerCountdown(0);
    }
  }

  /* -------------------------
   * API Calls
   * ------------------------- */

  async function sendGlow() {
    try {
      const res = await fetch(cfg.restBase + '/glow', {
        method: 'POST',
        headers: {
          'X-WP-Nonce': cfg.restNonce,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({}));
      const msg = data.message || texts.glowToast || 'Glow sent ✨';
      showToast(msg);

      const total = (typeof data.total === 'number') ? data.total : (stats.glowsTotal || 0);
      const counterEl = document.getElementById('lof-glow-counter');
      if (counterEl && texts.glowCounter) {
        counterEl.textContent = formatTemplate(texts.glowCounter, { count: total });
      }
    } catch (e) {
      console.error('[LOF] glow error', e);
      showToast('Glow didn’t send, but you still added to the vibe.');
    }
  }

  async function triggerSpeaker() {
    try {
      const res = await fetch(cfg.restBase + '/speaker', {
        method: 'POST',
        headers: {
          'X-WP-Nonce': cfg.restNonce,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({}));
      const status = data.status || 'ok';
      const msg = data.message || texts.speakerSuccess || 'Speaker toggled.';
      showToast(msg);

      if (typeof data.secondsRemaining === 'number') {
        startSpeakerCountdown(data.secondsRemaining);
      } else if (status === 'ok') {
        startSpeakerCountdown(speakerDuration);
      }
    } catch (e) {
      console.error('[LOF] speaker error', e);
      showToast(texts.speakerError || 'Speaker command did not go through.');
    }
  }

  async function triggerFog() {
    try {
      const res = await fetch(cfg.restBase + '/fog', {
        method: 'POST',
        headers: {
          'X-WP-Nonce': cfg.restNonce,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({}));
      const msg = data.message || texts.fogSuccess || 'Fog triggered.';
      showToast(msg);
    } catch (e) {
      console.error('[LOF] fog error', e);
      showToast(texts.fogError || 'Fog command did not go through.');
    }
  }

  async function fetchShowDetails() {
    if (!rfShowUrl) return null;
    try {
      const res = await fetch(rfShowUrl);
      if (!res.ok) {
        console.error('[LOF] rf showDetails error:', res.status);
        return null;
      }
      const data = await res.json();
      return data;
    } catch (e) {
      console.error('[LOF] rf showDetails fetch error:', e);
      return null;
    }
  }

  /* -------------------------
   * UI Builders
   * ------------------------- */

  function buildExtrasBar(viewer) {
    const statusPanel = viewer.querySelector('.rf-status-panel') || viewer.firstElementChild;
    if (!statusPanel) return;

    const bar = document.createElement('div');
    bar.id = 'lof-extras-bar';
    bar.className = 'lof-extras-bar';

    if (cfg.enableGlow) {
      const glowBtn = document.createElement('button');
      glowBtn.type = 'button';
      glowBtn.className = 'lof-pill-button lof-pill-button--glow';
      glowBtn.textContent = texts.glowButton || 'Send a Glow ✨';
      glowBtn.addEventListener('click', sendGlow);
      bar.appendChild(glowBtn);
    }

    if (cfg.enableSpeaker) {
      const speakerBtn = document.createElement('button');
      speakerBtn.type = 'button';
      speakerBtn.className = 'lof-pill-button lof-pill-button--speaker';
      speakerBtn.textContent = texts.speakerButton || 'Turn on speakers 🔊';
      speakerBtn.addEventListener('click', triggerSpeaker);
      bar.appendChild(speakerBtn);

      // Speaker status text
      speakerStatusEl = document.createElement('span');
      speakerStatusEl.id = 'lof-speaker-status';
      speakerStatusEl.style.marginLeft = '0.5rem';
      speakerStatusEl.style.fontSize = '0.8rem';
      speakerStatusEl.style.opacity = '0.9';
      bar.appendChild(speakerStatusEl);
    }

    if (cfg.enableFog) {
      const fogBtn = document.createElement('button');
      fogBtn.type = 'button';
      fogBtn.className = 'lof-pill-button lof-pill-button--fog';
      fogBtn.textContent = texts.fogButton || 'Puff smoke 🚂💨';
      fogBtn.addEventListener('click', triggerFog);
      bar.appendChild(fogBtn);
    }

    const microLine = document.createElement('div');
    microLine.id = 'lof-micro-line';
    microLine.className = 'lof-micro-line';

    // Glow counter text
    const counter = document.createElement('span');
    counter.id = 'lof-glow-counter';
    if (texts.glowCounter) {
      const total = stats.glowsTotal || 0;
      counter.textContent = formatTemplate(texts.glowCounter, { count: total });
    }

    // One random micro-story line
    const story = document.createElement('span');
    story.id = 'lof-micro-story';
    const line = chooseRandomLine(texts.microStories);
    if (line) {
      story.textContent = ' ' + line;
    }

    microLine.appendChild(counter);
    microLine.appendChild(story);

    if (statusPanel.nextSibling) {
      statusPanel.parentNode.insertBefore(bar, statusPanel.nextSibling);
      statusPanel.parentNode.insertBefore(microLine, bar.nextSibling);
    } else {
      statusPanel.parentNode.appendChild(bar);
      statusPanel.parentNode.appendChild(microLine);
    }

    // Initialize speaker state after DOM elements exist
    if (cfg.enableSpeaker) {
      fetchSpeakerStatus();
    }
  }

  function buildTonightPanel(viewer) {
    const container = viewer.parentNode;
    if (!container) return;

    const panel = document.createElement('section');
    panel.id = 'lof-tonight-panel';
    panel.className = 'lof-tonight-panel';

    const heading = document.createElement('h2');
    heading.className = 'lof-tonight-heading';
    heading.textContent = texts.tonightHeading || 'Tonight at Lights on Falcon';

    const body = document.createElement('div');
    body.id = 'lof-tonight-body';
    body.className = 'lof-tonight-body';

    panel.appendChild(heading);
    panel.appendChild(body);

    if (viewer.nextSibling) {
      container.insertBefore(panel, viewer.nextSibling);
    } else {
      container.appendChild(panel);
    }

    updateTonightPanel();
    setInterval(updateTonightPanel, 15000);
  }

  async function updateTonightPanel() {
    const body = document.getElementById('lof-tonight-body');
    if (!body) return;

    const data = await fetchShowDetails();
    if (!data || typeof data !== 'object') {
      body.innerHTML = '<p>' + escapeHtml('The show status is warming up. Look up and enjoy what\'s already glowing.') + '</p>';
      return;
    }

    const prefs = data.preferences || {};
    const mode  = String(prefs.viewerControlMode || 'UNKNOWN').toUpperCase();
    const enabled = !!prefs.viewerControlEnabled;
    const queueLen = Array.isArray(data.queue) ? data.queue.length : (data.queueLength || 0);

    let mainCopy;
    if (!enabled) {
      mainCopy = texts.copyOff;
    } else if (mode === 'JUKEBOX') {
      mainCopy = texts.copyJukebox;
    } else if (mode === 'VOTING') {
      mainCopy = texts.copyVoting;
    } else {
      mainCopy = texts.copyOther;
    }

    const lines = [];

    // Showtime vs drop-by lines (schedule-based)
    const showStatus = getShowtimeStatus();
    if (showStatus) {
      if (showStatus.mode === 'showtime_now') {
        if (texts.copyShowtimeLead) {
          lines.push(texts.copyShowtimeLead);
        }
        if (texts.copyShowtimeNow) {
          lines.push(texts.copyShowtimeNow);
        }
      } else if (showStatus.mode === 'showtime_soon') {
        if (texts.copyShowtimeLead) {
          lines.push(texts.copyShowtimeLead);
        }
        if (texts.copyShowtimeCountdown && showStatus.minutesToNext > 0) {
          lines.push(
            formatTemplate(texts.copyShowtimeCountdown, {
              minutes: showStatus.minutesToNext
            })
          );
        }
      } else if (showStatus.mode === 'adhoc') {
        if (texts.copyAdhocLead) {
          lines.push(texts.copyAdhocLead);
        }
        if (texts.copyAdhocHint) {
          lines.push(texts.copyAdhocHint);
        }
      }
    }

    if (mainCopy) {
      String(mainCopy)
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(line => lines.push(line));
    }

    // Queue line
    if (queueLen > 0 && texts.copyQueueLine) {
      lines.push(formatTemplate(texts.copyQueueLine, { count: queueLen }));
    } else if (queueLen === 0 && texts.copyQueueEmpty) {
      lines.push(texts.copyQueueEmpty);
    }

    // Acts-of-light / kindness prompt
    const kindness = chooseRandomLine(texts.kindnessPrompts);
    if (kindness) {
      lines.push('Tiny mission (if you want one): ' + kindness);
    }

    if (texts.copyFooter) {
      lines.push(texts.copyFooter);
    }

    body.innerHTML = lines
      .map(l => '<p>' + escapeHtml(l) + '</p>')
      .join('');
  }

  /* -------------------------
   * Init
   * ------------------------- */

  document.addEventListener('DOMContentLoaded', function () {
    const viewer = document.getElementById('rf-viewer');
    if (!viewer) return;

    buildExtrasBar(viewer);
    buildTonightPanel(viewer);
  });
})();