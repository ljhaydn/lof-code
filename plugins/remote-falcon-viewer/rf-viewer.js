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
    // we don't want to break the viewer â€“ just log and move on.
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

  // Local â€œidentityâ€ for this device
  const STORAGE_REQUESTS_KEY = 'lofRequestedSongs_v1';
  const STORAGE_STATS_KEY    = 'lofViewerStats_v1';
  const STORAGE_GLOW_KEY     = 'lofGlowLastTime_v1';

  let requestedSongNames = loadRequestedSongs();
  let viewerStats        = loadStats();

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
   * Fetch viewer state via unified WP endpoint
   * Falls back to old showDetails if unified fails
   * ------------------------- */

  // Store enhanced state data from unified endpoint
  let viewerState = null;

  async function fetchShowDetails() {
    if (!base) return;

    try {
      // Try unified endpoint first (includes FPP data + derived state)
      const stateRes = await fetch('/wp-json/lof/v1/viewer-state');
      if (stateRes.ok) {
        const stateData = await stateRes.json();
        viewerState = stateData;
        renderShowDetails(stateData);
        return;
      }
    } catch (err) {
      console.warn('[RF] Unified viewer-state failed, falling back:', err);
    }

    // Fallback to original RF-only endpoint
    try {
      const res = await fetch(base + '/showDetails');
      if (!res.ok) {
        console.error('[RF] showDetails error:', res.status);
        return;
      }

      const data = await res.json();
      viewerState = null; // No enhanced state available
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
        'You can still enjoy the show â€” weâ€™ll turn song requests and voting back on soon.'
      );
      headlineEl.textContent = title;
      subcopyEl.textContent  = body;
      return;
    }

    if (mode === 'JUKEBOX') {
      const title = lofCopy(
        'header_jukebox_title',
        'Tap a song to request it ðŸŽ§'
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
            'Late-night Falcon fans are the real MVPs. ðŸŒ™'
          )
        );
      }

      subcopyEl.textContent = parts.join(' ');
      return;
    }

    if (mode === 'VOTING') {
      const title = lofCopy(
        'header_voting_title',
        'Vote for your favorites ðŸ—³ï¸'
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
            'Bonus points for after-dark voting energy. ðŸŒ’'
          )
        );
      }

      subcopyEl.textContent = parts.join(' ');
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
      text = 'Your request is playing right now. Enjoy the glow âœ¨';
    } else if (queuePos != null) {
      text = `Your song is currently #${queuePos} in the queue.`;
    } else {
      text =
        'Your last request has already run its course. Pick another and keep the show moving. ðŸŽ¶';
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
      : (playingNextRaw || 'â€”');

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
    
    // Enhanced "Next Up" display using unified state
    if (nextTitleEl) {
      if (viewerState && viewerState.state) {
        const state = viewerState.state;
        
        if (state.isAfterHours) {
          nextTitleEl.textContent = 'Tomorrow at 5pm';
        } else if (state.isLockout) {
          nextTitleEl.textContent = '🎄 ' + state.nextShowTime + ' show starting soon';
        } else if (viewerState.nextUp && viewerState.nextUp.displayName) {
          // Queue has items - show next requested song
          const waitMin = Math.ceil((viewerState.nextUp.waitSeconds || 0) / 60);
          nextTitleEl.textContent = '🎵 ' + viewerState.nextUp.displayName;
        } else if (state.isIntermission) {
          nextTitleEl.textContent = '🎶 Your call — request a song below';
        } else if (state.isShowPlaylist) {
          nextTitleEl.textContent = '🎲 DJ Falcon is picking...';
        } else {
          nextTitleEl.textContent = nextDisplay;
        }
      } else {
        nextTitleEl.textContent = nextDisplay;
      }
    }
    
    // Enhanced "Now Playing" subtitle
    if (nowArtistEl) {
      if (viewerState && viewerState.now && isPlayingReal) {
        const nowInfo = viewerState.now;
        const remaining = nowInfo.secondsRemaining || 0;
        const remainStr = formatTimeRemaining(remaining);
        
        if (nowInfo.isRequest) {
          nowArtistEl.textContent = 'Requested by a guest' + (remainStr ? ' • ' + remainStr + ' left' : '');
        } else if (nowArtist) {
          nowArtistEl.textContent = nowArtist + (remainStr ? ' • ' + remainStr + ' left' : '');
        } else {
          nowArtistEl.textContent = 'From tonight\'s playlist' + (remainStr ? ' • ' + remainStr + ' left' : '');
        }
      } else {
        nowArtistEl.textContent = nowArtist;
      }
    }

    const queueLength = rawRequests.length || 0;
    const phase = isIntermission ? 'intermission' : (isPlayingReal ? 'showtime' : 'idle');
    lastPhase = phase;

    updateHeaderCopy(currentMode, currentControlEnabled, prefs, queueLength, phase);
    updateBanner(phase);
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
        chip.textContent = isNow ? 'Your pick is playing âœ¨' : 'You picked this';
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
          When interactive mode is back on, youâ€™ll see the live request queue or top-voted songs here.
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
          Interactive controls are on, but this mode doesnâ€™t expose queue or vote data.
        </div>
      `;
    }

    renderStats(extra, queueLength);
    addGlowCard(extra);
    addSpeakerCard(extra);
  }

  function renderQueue(extra, data) {
    const rawRequests = Array.isArray(data.requests) ? data.requests : [];
    
    // Get enhanced queue with wait times if available
    const enhancedQueue = (viewerState && viewerState.queue) ? viewerState.queue : null;
    const stateInfo = (viewerState && viewerState.state) ? viewerState.state : null;

    const header = document.createElement('div');
    header.innerHTML = `
      <div class="rf-extra-title">Up Next Queue</div>
      <div class="rf-extra-sub">
        Songs requested by guests appear here in the order they're queued.
      </div>
    `;
    extra.appendChild(header);
    
    // Add reset warning banner if within 15 minutes of reset
    if (stateInfo && stateInfo.timeUntilResetSeconds && stateInfo.timeUntilResetSeconds < 900) {
      const resetMin = Math.ceil(stateInfo.timeUntilResetSeconds / 60);
      const warningDiv = document.createElement('div');
      warningDiv.className = 'rf-queue-warning';
      
      if (stateInfo.isLockout) {
        warningDiv.innerHTML = `
          <span class="rf-queue-warning-icon">⏸️</span>
          <span>Requests paused — ${stateInfo.nextShowTime} show starting soon</span>
        `;
      } else {
        warningDiv.innerHTML = `
          <span class="rf-queue-warning-icon">🔄</span>
          <span>Queue resets at ${stateInfo.nextShowTime} (${resetMin} min) — request now!</span>
        `;
      }
      extra.appendChild(warningDiv);
    }

    const list = document.createElement('ul');
    list.className = 'rf-queue-list';

    if (!rawRequests.length) {
      const empty = document.createElement('div');
      empty.className = 'rf-extra-sub';
      empty.textContent =
        'No songs in queue yet. Pick one below to be next!';
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
      
      // Get wait time from enhanced queue if available
      let waitStr = '';
      if (enhancedQueue && enhancedQueue[idx]) {
        const waitSec = enhancedQueue[idx].waitSeconds || 0;
        waitStr = formatWaitTime(waitSec);
      }

      const li = document.createElement('li');
      li.className = 'rf-queue-item';
      li.innerHTML = `
        <span class="rf-queue-position">#${pos}</span>
        <span class="rf-queue-song">${escapeHtml(displayTitle)}</span>
        ${waitStr ? `<span class="rf-queue-wait">${waitStr}</span>` : ''}
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
      empty.textContent = 'No votes yet â€” tap a song to send the first one.';
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
    const surpriseLabel = lofCopy('stats_surprise_label', 'â€œSurprise meâ€ taps');
    const vibeLabel     = lofCopy('stats_vibe_label', 'Falcon vibe check');

    let vibeText = lofCopy('stats_vibe_low', 'Cozy & chill ðŸ˜Œ');
    if (queueLength >= 3 && queueLength <= 7) {
      vibeText = lofCopy('stats_vibe_med', 'Party forming ðŸ•º');
    } else if (queueLength > 7) {
      vibeText = lofCopy('stats_vibe_high', 'Full-send Falcon ðŸ”¥');
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

  function addGlowCard(extra) {
    const title       = lofCopy('glow_title', 'Send a little glow ðŸ’š');
    const sub         = lofCopy('glow_sub', 'Drop a short note of thanks, joy, or encouragement.');
    const placeholder = lofCopy('glow_placeholder', 'Tell us who made your night, or what made you smileâ€¦');
    const namePlaceholder = lofCopy('glow_name_placeholder', 'Name or initials (optional)');
    const btnLabel    = lofCopy('glow_btn', 'Send this glow âœ¨');

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
          'Give us a little more than that. ðŸ™‚'
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
      btnEl.textContent = 'Sending glowâ€¦';

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
            'Glow sent. Thanks for sharing the love. ðŸ’š'
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
  const btnLabelOn = lofCopy('speaker_btn_on', 'Turn speakers on ðŸ”Š');
  const timePrefix = lofCopy('speaker_time_left_prefix', 'Time left:');
  const fmLabel = lofCopy('speaker_fm_label', 'FM radio');
  const fmText = lofCopy(
    'speaker_fm_text',
    'Prefer the car stereo? Tune to 88.3 FM near the show.'
  );
  const streamLabel = lofCopy('speaker_stream_label', 'Listen on your phone');

  // TODO: if we later wire this into LOF Extras settings, read from config instead.
  const pulsemeshUrl = 'broken link here';

  const card = document.createElement('div');
  card.className = 'rf-card rf-speaker-card';

  card.innerHTML = `
    <div class="rf-card-inner">
      <div class="rf-card-header">Need sound?</div>

      <div class="rf-card-body">
        <div id="rf-speaker-status-text" class="rf-speaker-status">
          Checking speaker statusâ€¦
        </div>

        <div class="rf-card-primary-action">
          <button id="rf-speaker-btn" class="rf-card-btn">
            ${escapeHtml(btnLabelOn)}
          </button>

          <div class="rf-card-timer">
            <span class="rf-card-timer-label">
              ${escapeHtml(timePrefix)}
            </span>
            <span id="lof-speaker-countdown-inline"
                  class="rf-card-timer-value"></span>
          </div>
        </div>

        <div class="rf-card-divider"></div>

        <div class="rf-audio-options">
          <div class="rf-audio-options-label">
            Other ways to listen:
          </div>

          <details class="rf-audio-option rf-audio-option--stream" open>
            <summary>${escapeHtml(streamLabel)}</summary>
            <div class="rf-audio-option-body">
              <iframe
                src="${pulsemeshUrl}"
                title="Lights on Falcon live stream"
                loading="lazy"
                class="rf-audio-iframe"
                allow="autoplay"
              ></iframe>
            </div>
          </details>

          <div class="rf-audio-option rf-audio-option--fm">
            <div class="rf-audio-option-title">${escapeHtml(fmLabel)}</div>
            <div class="rf-audio-option-body">
              ${escapeHtml(fmText)}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  extra.appendChild(card);

  const btn = card.querySelector('#rf-speaker-btn');
  const statusText = card.querySelector('#rf-speaker-status-text');
  const countdownEl = card.querySelector('#lof-speaker-countdown-inline');
  const timerRow = card.querySelector('.rf-card-timer');

  // hide timer row by default
  if (timerRow) timerRow.style.display = 'none';

  // Optional: only show speaker button on â€œmobile-ishâ€ widths
  if (window.innerWidth > 900 && btn) {
    btn.style.display = 'none';
  }

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

      if (res.ok && data && typeof data.speakerOn === 'boolean') {
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

          if (rem > 0) {
            const minutes = Math.ceil(rem / 60);
            const label = minutes <= 1
              ? 'about 1 minute'
              : `about ${minutes} minutes`;

            statusText.textContent = statusOnText;
            if (countdownEl) countdownEl.textContent = label;
            if (timerRow) timerRow.style.display = 'flex';
          } else {
            statusText.textContent = statusOnText;
            if (countdownEl) countdownEl.textContent = '';
            if (timerRow) timerRow.style.display = 'none';
          }
        } else {
          // Speaker OFF
          const statusOffText = lofCopy(
            'speaker_status_off',
            'Speakers are currently OFF. If youâ€™re standing at the show, you can turn them on.'
          );

          statusText.textContent = statusOffText;
          if (countdownEl) countdownEl.textContent = '';
          if (timerRow) timerRow.style.display = 'none';
        }
      } else if (data && data.message) {
        statusText.textContent = data.message;
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
      btn.textContent = 'Talking to the showâ€¦';

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

    const title    = lofCopy('surprise_title', 'Canâ€™t pick just one?');
    const subtitle = lofCopy('surprise_sub', 'Let us queue up a random crowd-pleaser for you.');
    const btnText  = lofCopy('surprise_btn', 'Surprise me âœ¨');

    card.innerHTML = `
      <div class="rf-card-title">${escapeHtml(title)}</div>
      <div class="rf-card-artist">
        ${escapeHtml(subtitle)}
      </div>
      <div class="rf-card-meta">
        <span class="rf-card-duration">Weâ€™ll choose from tonightâ€™s available songs.</span>
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

    // Check for lockout via enhanced state
    if (viewerState && viewerState.state) {
      const state = viewerState.state;
      
      // Hard lockout - no requests allowed
      if (state.isLockout) {
        showToast(`🎄 Requests paused — ${state.nextShowTime} show starting soon!`, 'error');
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
          showToast(`⏱️ This song won't finish before the ${state.nextShowTime} reset (${resetMin} min). Try a shorter one!`, 'error');
          return;
        }
      }
    }

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
      btn.textContent = (mode === 'VOTING') ? 'Sending voteâ€¦' : 'Sending requestâ€¦';
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
          ? `Vote sent! You're helping pick the next song.${codeMessage}`
          : `🎵 Request sent! You're in the queue.${codeMessage}`;
        
        // Add warning if close to reset
        if (viewerState && viewerState.state && viewerState.state.timeUntilResetSeconds < 600) {
          const resetMin = Math.ceil(viewerState.state.timeUntilResetSeconds / 60);
          msg += ` ⚡ Queue resets in ${resetMin} min`;
        }
        
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
      showToast('Network issueâ€”please try again.', 'error');
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
        'You like chaos. We respect that. ðŸ˜ˆ'
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

  function formatTimeRemaining(seconds) {
    if (!seconds || seconds <= 0) return '';
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return min + ':' + String(sec).padStart(2, '0');
  }

  function formatWaitTime(seconds) {
    if (!seconds || seconds <= 0) return 'playing now';
    const min = Math.ceil(seconds / 60);
    if (min < 1) return '<1 min wait';
    return '~' + min + ' min wait';
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