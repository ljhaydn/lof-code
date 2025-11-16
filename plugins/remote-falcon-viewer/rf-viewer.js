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
        // Banner + stats + surprise + tonight panel copy all come from here.
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

  // Simple per-device rate limit for "Send a Glow"
  let lastGlowTime = 0;
  const GLOW_COOLDOWN_MS = 30000; // 30 seconds

  // Local “identity” for this device
  const STORAGE_REQUESTS_KEY = 'lofRequestedSongs_v1';
  const STORAGE_STATS_KEY    = 'lofViewerStats_v1';

  let requestedSongNames = loadRequestedSongs();
  let viewerStats        = loadStats();

  // last requested song (name) this session
  let lastRequestedSequenceName = null;

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

  function updateHeaderCopy(mode, enabled, prefs, queueLength, phase) {
    const headlineEl = document.getElementById('rf-viewer-headline');
    const subcopyEl  = document.getElementById('rf-viewer-subcopy');
    if (!headlineEl || !subcopyEl) return;

    const requestLimit   = prefs.jukeboxRequestLimit || null;
    const locationMethod = prefs.locationCheckMethod || 'NONE';

    const late = isLateNight();
    let phaseLine = '';

    if (phase === 'intermission') {
      phaseLine = 'Intermission: the lights are catching their breath. 🎭 ';
    } else if (phase === 'showtime') {
      phaseLine = 'Showtime: lights synced, neighbors vibing. ✨ ';
    }

    if (!enabled) {
      headlineEl.textContent = 'Viewer control is currently paused';
      subcopyEl.textContent =
        phaseLine +
        'You can still enjoy the show — we’ll turn song requests and voting back on soon.';
      return;
    }

    if (mode === 'JUKEBOX') {
      headlineEl.textContent = 'Tap a song to request it 🎧';

      const bits = [];

      bits.push(phaseLine + 'Requests join the queue in the order they come in.');

      if (queueLength > 0) {
        bits.push(
          `There ${queueLength === 1 ? 'is' : 'are'} currently ${queueLength} song${queueLength === 1 ? '' : 's'} in the queue.`
        );
      }

      if (requestLimit && requestLimit > 0) {
        bits.push(
          `You can request up to ${requestLimit} song${requestLimit > 1 ? 's' : ''} per session.`
        );
      }
      if (locationMethod && locationMethod !== 'NONE') {
        bits.push('Viewer control may be limited to guests near the show location.');
      }
      if (late) {
        bits.push('Late-night Falcon fans are the real MVPs. 🌙');
      }

      subcopyEl.textContent = bits.join(' ');
      return;
    }

    if (mode === 'VOTING') {
      headlineEl.textContent = 'Vote for your favorites 🗳️';

      const bits = [];
      bits.push(
        phaseLine +
          'Songs with the most votes rise to the top. Tap a track below to help decide what plays next.'
      );
      if (late) {
        bits.push('Bonus points for after-dark voting energy. 🌒');
      }

      subcopyEl.textContent = bits.join(' ');
      return;
    }

    headlineEl.textContent = 'Interactive show controls';
    subcopyEl.textContent =
      phaseLine +
      'Use the controls below to interact with the Lights on Falcon show in real time.';
  }

  function updateMyStatusLine(nowSeq, queue, nowKey) {
    const myStatusEl = document.getElementById('rf-viewer-my-status');
    if (!myStatusEl) return;

    if (!lastRequestedSequenceName) {
      myStatusEl.textContent = '';
      myStatusEl.style.display = 'none';
      return;
    }

    const myName = lastRequestedSequenceName;
    let queuePos = null;

    if (Array.isArray(queue) && queue.length) {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        if (!item || typeof item !== 'object') continue;
        const seq = item.sequence || {};
        const sName = seq.name || seq.displayName;
        if (sName && sName === myName) {
          const pos =
            typeof item.position === 'number'
              ? item.position
              : i + 1;
          queuePos = pos;
          break;
        }
      }
    }

    const nowIsMine =
      nowSeq &&
      (nowSeq.name === myName || nowSeq.displayName === myName);

    let text = '';
    if (nowIsMine) {
      text = 'Your request is playing right now. Enjoy the glow ✨';
    } else if (queuePos != null) {
      text = `Your song is currently #${queuePos} in the queue.`;
    } else {
      text =
        'Your last request has already run its course. Pick another and keep the show moving. 🎶';
    }

    myStatusEl.textContent = text;
    myStatusEl.style.display = 'block';
  }

  /* -------------------------
   * Main render
   * ------------------------- */

  function renderShowDetails(data) {
    if (!data || typeof data !== 'object') return;

    const prefs        = data.preferences || {};
    const sequences    = Array.isArray(data.sequences) ? data.sequences : [];
    const rawRequests  = Array.isArray(data.requests) ? data.requests : [];
    const rawVotes     = Array.isArray(data.votes)    ? data.votes    : [];

    currentMode           = prefs.viewerControlMode || 'UNKNOWN';
    currentControlEnabled = !!prefs.viewerControlEnabled;

    if (typeof currentMode === 'string') {
      currentMode = currentMode.toUpperCase();
    }

    const modeLabel = formatModeLabel(currentMode, currentControlEnabled);

    const playingNowRaw  = data.playingNow || '';
    const playingNextRaw = data.playingNext || '';

    ensureHeader();
    ensureControls();
    ensureMainLayout();

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

    // DIM LOGIC (uses display title):
    const hasRawNow      = !!(playingNowRaw && playingNowRaw.toString().trim());
    const isIntermission = nowDisplay && /intermission/i.test(nowDisplay);
    const isPlayingReal  = hasRawNow && !isIntermission;

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

    const queueLength = rawRequests.length || 0;
    const phase = isIntermission ? 'intermission' : (isPlayingReal ? 'showtime' : 'idle');
    updateHeaderCopy(currentMode, currentControlEnabled, prefs, queueLength, phase);

    updateMyStatusLine(nowSeq, rawRequests, nowKey);

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
        chip.textContent = isNow ? 'Your pick is playing ✨' : 'You picked this';
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
    renderExtraPanel(currentMode, currentControlEnabled, data, queueLength, phase);
  }
  /* -------------------------
   * Phase banner ("Tonight on Falcon")
   * ------------------------- */

  function addPhaseBanner(extra, phase, mode, enabled) {
    // Fallbacks if LOF Extras doesn’t provide copy yet
    let titleKey;
    let subKey;
    let defaultTitle;
    let defaultSub;

    if (phase === 'showtime') {
      titleKey     = 'banner_showtime_title';
      subKey       = 'banner_showtime_sub';
      defaultTitle = 'Showtime on Falcon ✨';
      defaultSub   = 'Lights are synced to the music right now. Pick a song or just soak it in.';
    } else if (phase === 'intermission') {
      titleKey     = 'banner_intermission_title';
      subKey       = 'banner_intermission_sub';
      defaultTitle = 'Intermission — lights still glowing';
      defaultSub   = 'We’re in between featured songs. The lights are in “ambient” mode while guests wander and explore.';
    } else {
      // idle / unknown
      titleKey     = 'banner_idle_title';
      subKey       = 'banner_idle_sub';
      defaultTitle = 'Welcome to Lights on Falcon';
      defaultSub   = 'Show times kick in on the hour most evenings. If you’re here off-cycle, you might catch ambient patterns or a surprise track.';
    }

    let title = lofCopy(titleKey, defaultTitle);
    let sub   = lofCopy(subKey, defaultSub);

    // If viewer control is paused, layer that into the message
    if (!enabled) {
      const pausedTitle = lofCopy(
        'banner_paused_title',
        'Requests are taking a breather'
      );
      const pausedSub = lofCopy(
        'banner_paused_sub',
        'You can still enjoy the show. We’ll turn viewer control back on soon so you can help steer the playlist.'
      );
      title = pausedTitle;
      sub   = pausedSub;
    }

    const banner = document.createElement('div');
    banner.className = 'rf-phase-banner';

    banner.innerHTML = `
      <div class="rf-phase-banner-title">${escapeHtml(title)}</div>
      <div class="rf-phase-banner-sub">${escapeHtml(sub)}</div>
    `;

    extra.appendChild(banner);
  }
  /* -------------------------
   * Extra panel (queue / leaderboard / stats / speakers / glow)
   * ------------------------- */

  function renderExtraPanel(mode, enabled, data, queueLength, phase) {
    const extra = document.getElementById('rf-extra-panel');
    if (!extra) return;

    extra.innerHTML = '';

    // Phase banner at the top
    addPhaseBanner(extra, phase, mode, enabled);

    if (!enabled) {
      extra.innerHTML += `
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
      extra.innerHTML += `
        <div class="rf-extra-title">Show status</div>
        <div class="rf-extra-sub">
          Interactive controls are on, but this mode doesn’t expose queue or vote data.
        </div>
      `;
    }

    renderStats(extra, queueLength);
    addGlowCard(extra);
    addSpeakerCard(extra);
  }

  /**
   * "Tonight" panel – top of right column.
   * Priority (Option A):
   * 1. Offseason override
   * 2. After-hours override
   * 3. Intermission override
   * 4. Showtime override
   * 5. Default enabled / disabled copy
   */
  function renderTonightPanel(extra, mode, enabled, data, queueLength, phase, nextDisplay) {
    if (!extra) return;

    const sequences   = Array.isArray(data.sequences) ? data.sequences : [];
    const rawRequests = Array.isArray(data.requests)  ? data.requests  : [];
    const rawVotes    = Array.isArray(data.votes)     ? data.votes     : [];
    const playingNow  = data.playingNow || '';

    const afterHours  = isLateNight();

    // Very lightweight "offseason" heuristic: nothing playing, no sequences, no queue, no votes
    const isOffseason = (
      !sequences.length &&
      !playingNow &&
      !rawRequests.length &&
      !rawVotes.length
    );

    const title = lofCopy('tonight_title', 'Tonight at Lights on Falcon');

    // Base copies
    const enabledSub   = lofCopy(
      'tonight_enabled_sub',
      'You’re in the mix — tap a song below to shape the show.'
    );
    const disabledSub  = lofCopy(
      'tonight_disabled_sub',
      'Requests are paused while we line up the next moment.'
    );

    let sub = enabled ? enabledSub : disabledSub;

    // Overrides with priority A
    const offSeasonOverride  = lofCopy('tonight_offseason_override', '');
    const afterHoursOverride = lofCopy('tonight_afterhours_override', '');
    const intermissionOverride = lofCopy('tonight_intermission_override', '');
    const showtimeOverride     = lofCopy('tonight_showtime_override', '');

    if (isOffseason && offSeasonOverride.trim() !== '') {
      sub = offSeasonOverride;
    } else if (afterHours && afterHoursOverride.trim() !== '') {
      sub = afterHoursOverride;
    } else if (phase === 'intermission' && intermissionOverride.trim() !== '') {
      sub = intermissionOverride;
    } else if (phase === 'showtime' && showtimeOverride.trim() !== '') {
      sub = showtimeOverride;
    }

    // Queue line w/ tokens
    const queueTemplate = lofCopy(
      'tonight_queue_line',
      'There are {queue_count} requests ahead. Next up: {next_title}.'
    );
    const queueLine = formatTonightTemplate(queueTemplate, {
      queue_count: queueLength,
      next_title:  nextDisplay || '—',
      mode:        mode || 'UNKNOWN',
      my_requests: viewerStats && typeof viewerStats.requests === 'number'
        ? viewerStats.requests
        : 0
    });

    const footer = lofCopy(
      'tonight_footer',
      'Thanks for being part of the glow. 💚'
    );

    const wrapper = document.createElement('div');
    wrapper.className = 'rf-tonight';

    wrapper.innerHTML = `
      <div class="rf-tonight-title">${escapeHtml(title)}</div>
      ${sub && sub.trim() !== '' ? `
        <div class="rf-tonight-sub">${escapeHtml(sub)}</div>
      ` : ''}
      ${queueLine && queueLine.trim() !== '' ? `
        <div class="rf-tonight-queue">${escapeHtml(queueLine)}</div>
      ` : ''}
      ${footer && footer.trim() !== '' ? `
        <div class="rf-tonight-footer">${escapeHtml(footer)}</div>
      ` : ''}
    `;

    extra.appendChild(wrapper);
  }

  function renderQueue(extra, data) {
    const rawRequests = Array.isArray(data.requests) ? data.requests : [];

    const header = document.createElement('div');
    header.innerHTML = `
      <div class="rf-extra-title">Up Next Queue</div>
      <div class="rf-extra-sub">
        Songs requested by guests appear here in the order they’re queued.
      </div>
    `;
    extra.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'rf-queue-list';

    if (!rawRequests.length) {
      const empty = document.createElement('div');
      empty.className = 'rf-extra-sub';
      empty.textContent =
        'Requests are handled behind the scenes by Remote Falcon. When your pick is ready, you’ll see it glow as “Next Up.”';
      extra.appendChild(list);
      extra.appendChild(empty);
      return;
    }

    rawRequests.forEach((item, idx) => {
      if (!item || typeof item !== 'object') return;

      const seq = (item.sequence && typeof item.sequence === 'object') ? item.sequence : {};
      const displayTitle = seq.displayName || seq.name || 'Untitled';
      const artist       = seq.artist || '';
      const pos          = (typeof item.position === 'number')
        ? item.position
        : idx + 1;

      const li = document.createElement('li');
      li.className = 'rf-queue-item';
      li.innerHTML = `
        <span class="rf-queue-position">#${pos}</span>
        <span class="rf-queue-song">${escapeHtml(displayTitle)}</span>
        ${artist ? `<span class="rf-queue-artist">${escapeHtml(artist)}</span>` : ''}
      `;
      list.appendChild(li);
    });

    extra.appendChild(list);
  }

  function renderLeaderboard(extra, data) {
    const rawVotes = Array.isArray(data.votes) ? data.votes : [];

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
    extra.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'rf-leaderboard-list';

    if (!top.length) {
      const empty = document.createElement('div');
      empty.className = 'rf-extra-sub';
      empty.textContent = 'No votes yet — tap a song to send the first one.';
      extra.appendChild(list);
      extra.appendChild(empty);
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

    extra.appendChild(list);
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
   * Glow card (Send a little love)
   * ------------------------- */

  function addGlowCard(extra) {
    // Feature flag from LOF Extras, but very forgiving:
    // - If features.glow === false → hide
    // - Anything else → show
    let glowEnabled = true;
    try {
      if (
        LOFViewer &&
        LOFViewer.config &&
        LOFViewer.config.features &&
        Object.prototype.hasOwnProperty.call(LOFViewer.config.features, 'glow')
      ) {
        if (LOFViewer.config.features.glow === false) {
          glowEnabled = false;
        }
      }
    } catch (e) {
      // If anything is weird, keep it enabled instead of silently hiding the card
      glowEnabled = true;
    }

    if (!glowEnabled) return;

    const card = document.createElement('div');
    card.className = 'rf-glow-card';

    const title       = lofCopy('glow_title', 'Send a little glow 💚');
    const subtitle    = lofCopy(
      'glow_sub',
      'Drop a short note of thanks, joy, or encouragement.'
    );
    const placeholder = lofCopy(
      'glow_placeholder',
      'Tell us who made your night, or what made you smile…'
    );
    // Button label uses glow_btn (matches LOF Extras)
    const btnLabel    = lofCopy('glow_btn', 'Send this glow ✨');

    card.innerHTML = `
      <div class="rf-extra-title">${escapeHtml(title)}</div>
      <div class="rf-extra-sub">
        ${escapeHtml(subtitle)}
      </div>
      <textarea
        id="rf-glow-message"
        class="rf-glow-input"
        rows="3"
        maxlength="280"
        placeholder="${escapeHtml(placeholder)}"
      ></textarea>
      <div class="rf-glow-actions">
        <button id="rf-glow-btn" class="rf-glow-btn">
          ${escapeHtml(btnLabel)}
        </button>
      </div>
      <div class="rf-glow-footnote">
        Keep it kind. We’re all neighbors here. 💚
      </div>
    `;

    extra.appendChild(card);

    const textarea = card.querySelector('#rf-glow-message');
    const button   = card.querySelector('#rf-glow-btn');

    if (!textarea || !button) return;

    button.addEventListener('click', async () => {
      const now = Date.now();
      if (now - lastGlowTime < GLOW_COOLDOWN_MS) {
        const remaining = Math.ceil((GLOW_COOLDOWN_MS - (now - lastGlowTime)) / 1000);
        const rateMsg = lofCopy(
          'glow_rate_limited',
          'You just sent a glow — give it a few seconds before sending another. ✨'
        );
        showToast(`${rateMsg} (${remaining}s)`, 'error');
        return;
      }

      const raw = (textarea.value || '').trim();
      if (!raw) {
        const emptyMsg = lofCopy(
          'glow_empty_error',
          'Add a short note before sending your glow.'
        );
        showToast(emptyMsg, 'error');
        return;
      }

      // Lock UI
      button.disabled = true;
      const oldLabel = button.textContent;
      button.textContent = 'Sending glow…';

      // Toasts use glow_success_toast / glow_error_toast (LOF Extras)
      const successMsg = lofCopy(
        'glow_success_toast',
        'Glow sent. Thanks for sharing the love. 💚'
      );
      const errorMsg = lofCopy(
        'glow_error_toast',
        'Could not send glow. Please try again.'
      );

      try {
        const res = await fetch('/wp-json/lof-extras/v1/glow', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          credentials: 'same-origin',
          body: JSON.stringify({
            message: raw
          })
        });

        const data = await res.json().catch(() => null);

        if (res.ok && data && data.success) {
          textarea.value = '';
          lastGlowTime = Date.now();
          showToast(data.message || successMsg, 'success');
        } else {
          const msg =
            (data && (data.message || data.error)) ||
            errorMsg;
          showToast(msg, 'error');
        }
      } catch (e) {
        showToast(errorMsg, 'error');
      } finally {
        button.disabled = false;
        button.textContent = oldLabel;
      }
    });
  }
  /* -------------------------
   * Speaker control card
   * ------------------------- */

  function addSpeakerCard(extra) {
    const card = document.createElement('div');
    card.className = 'rf-speaker-card';

    // These come from LOF Extras speaker settings where possible
    const title       = 'Need sound?'; // Card title – can make this configurable later
    const timePrefix  = lofCopy('speaker_time_left_prefix', 'Time left:');
    const buttonLabel = lofCopy('speaker_btn_on', 'Turn speakers on 🔊');

    card.innerHTML = `
      <div class="rf-extra-title">${escapeHtml(title)}</div>
      <div class="rf-extra-sub" id="rf-speaker-status-text">
        Checking speaker status…
      </div>
      <button id="rf-speaker-btn" class="rf-speaker-btn">
        ${escapeHtml(buttonLabel)}
      </button>
      <div class="rf-card-timer">
        <span class="rf-card-timer-label">${escapeHtml(timePrefix)}</span>
        <span id="lof-speaker-countdown-inline" class="rf-card-timer-value"></span>
      </div>
    `;

    extra.appendChild(card);

    const btn         = card.querySelector('#rf-speaker-btn');
    const statusText  = card.querySelector('#rf-speaker-status-text');
    const countdownEl = card.querySelector('#lof-speaker-countdown-inline');
    const timerRow    = card.querySelector('.rf-card-timer');

    // hide timer row by default
    if (timerRow) timerRow.style.display = 'none';

    // Optional: only show button on “mobile-ish” widths
    if (window.innerWidth > 900 && btn) {
      btn.style.display = 'none';
    }

    async function refreshSpeakerStatus() {
      if (!statusText) return;

      // Pull status copy from LOF Extras (with sane fallbacks)
      const textOn       = lofCopy(
        'speaker_status_on',
        'Speakers are currently ON near the show.'
      );
      const textOff      = lofCopy(
        'speaker_status_off',
        'Speakers are currently OFF. If you’re standing at the show, you can turn them on.'
      );
      const textUnknown  = lofCopy(
        'speaker_status_unknown',
        'Unable to read speaker status.'
      );
      const genericError = lofCopy(
        'speaker_error_msg',
        'Something glitched while talking to the speakers.'
      );

      try {
        const res = await fetch('/wp-content/themes/integrations/lof-speaker.php?action=status', {
          method: 'GET',
          headers: { Accept: 'application/json' }
        });
        const data = await res.json().catch(() => null);

        if (res.ok && data && typeof data.speakerOn === 'boolean') {
          const on  = data.speakerOn;
          const rem = typeof data.remainingSeconds === 'number' ? data.remainingSeconds : 0;

          if (on) {
            // Speaker ON
            if (rem > 0) {
              const minutes = Math.ceil(rem / 60);
              let label;
              if (minutes <= 1) {
                label = 'about 1 minute';
              } else {
                label = `about ${minutes} minutes`;
              }

              statusText.textContent = textOn;
              if (countdownEl) countdownEl.textContent = label;
              if (timerRow) timerRow.style.display = 'flex';
            } else {
              // ON but no remaining info → show ON, hide timer
              statusText.textContent = textOn;
              if (countdownEl) countdownEl.textContent = '';
              if (timerRow) timerRow.style.display = 'none';
            }
          } else {
            // Speaker OFF
            statusText.textContent = textOff;
            if (countdownEl) countdownEl.textContent = '';
            if (timerRow) timerRow.style.display = 'none';
          }
        } else if (data && data.message) {
          // Message coming from lof-speaker.php (e.g., "feature limited to on-site")
          statusText.textContent = data.message;
          if (countdownEl) countdownEl.textContent = '';
          if (timerRow) timerRow.style.display = 'none';
        } else {
          statusText.textContent = textUnknown;
          if (countdownEl) countdownEl.textContent = '';
          if (timerRow) timerRow.style.display = 'none';
        }
      } catch (e) {
        statusText.textContent = genericError;
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
          const res = await fetch('/wp-content/themes/integrations/lof-speaker.php?action=on', {
            method: 'POST',
            headers: { Accept: 'application/json' }
          });
          const data = await res.json().catch(() => null);

          if (res.ok && data && data.success) {
            // success toast – can later be wired to LOF Extras if we want
            showToast('Speakers should be on now. 🎶', 'success');
          } else {
            const fallbackErr = lofCopy(
              'speaker_error_msg',
              'Something glitched while talking to the speakers.'
            );
            const msg = (data && data.message) ? data.message : fallbackErr;
            showToast(msg, 'error');
          }
        } catch (e) {
          const networkErr = lofCopy(
            'speaker_error_msg',
            'Something glitched while talking to the speakers.'
          );
          showToast(networkErr, 'error');
        } finally {
          setTimeout(() => {
            btn.disabled = false;
            btn.textContent = oldText;
            refreshSpeakerStatus();
          }, 1500);
        }
      });
    }

    refreshSpeakerStatus();
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

    const endpoint = (mode === 'VOTING') ? '/vote' : '/request';
    const sequenceKey = seq.name;
    const now = Date.now();

    if (lastActionTimes[sequenceKey] && now - lastActionTimes[sequenceKey] < ACTION_COOLDOWN) {
      const remaining = Math.ceil((ACTION_COOLDOWN - (now - lastActionTimes[sequenceKey])) / 1000);
      showToast(`Please wait ${remaining}s before interacting with this song again.`, 'error');
      return;
    }

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

    viewerStats.surprise += 1;
    saveStats();

    if (viewerStats.surprise === 4) {
      const fourthMsg = lofCopy(
        'surprise_fourth_time',
        'You like chaos. We respect that. 😈'
      );
      showToast(fourthMsg, 'success');
    }

    const randomIndex = Math.floor(Math.random() * currentVisibleSequences.length);
    const seq = currentVisibleSequences[randomIndex];

    handleAction(currentMode, seq, null);
  }

  /* -------------------------
   * Utils
   * ------------------------- */

  function formatTonightTemplate(template, context) {
    if (typeof template !== 'string' || !template) return '';
    const ctx = context || {};
    return template
      .replace(/\{queue_count\}/g, String(ctx.queue_count != null ? ctx.queue_count : '0'))
      .replace(/\{next_title\}/g, String(ctx.next_title != null ? ctx.next_title : '—'))
      .replace(/\{mode\}/g, String(ctx.mode != null ? ctx.mode : 'UNKNOWN'))
      .replace(/\{my_requests\}/g, String(ctx.my_requests != null ? ctx.my_requests : '0'));
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;/')
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
})();