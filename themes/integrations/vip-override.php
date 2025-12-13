<?php
/**
 * VIP Override Page - Dynamic song list
 * Location: /wp-content/themes/integrations/vip-override.php
 * 
 * Access: https://yoursite.com/wp-content/themes/integrations/vip-override.php
 * Requires: Admin login
 */

require_once($_SERVER['DOCUMENT_ROOT'] . '/wp-load.php');

// Require admin
if (!current_user_can('manage_options')) {
    wp_die('🔒 Admin access required');
}
?>
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>🎛️ DJ Override</title>
    <style>
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #fff;
            margin: 0;
            padding: 12px;
            min-height: 100vh;
            padding-bottom: 100px;
        }
        .header {
            text-align: center;
            padding: 8px 0 16px;
            position: sticky;
            top: 0;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            z-index: 50;
        }
        h1 {
            font-size: 1.4rem;
            margin: 0 0 4px;
        }
        .subtitle {
            opacity: 0.6;
            font-size: 0.8rem;
        }
        .controls {
            display: flex;
            gap: 8px;
            margin: 12px 0;
            flex-wrap: wrap;
            justify-content: center;
        }
        .mode-btn {
            padding: 10px 16px;
            background: #2a2a4a;
            border: 2px solid transparent;
            border-radius: 25px;
            color: #fff;
            font-size: 0.85rem;
            cursor: pointer;
            transition: all 0.2s;
        }
        .mode-btn.active {
            background: #e7fe00;
            color: #1a1a2e;
            font-weight: 600;
        }
        .search-wrap {
            margin: 12px 0;
        }
        .search {
            width: 100%;
            padding: 14px 18px;
            background: #2a2a4a;
            border: 1px solid #3a3a5a;
            border-radius: 12px;
            color: #fff;
            font-size: 1rem;
        }
        .search::placeholder { color: #888; }
        .search:focus {
            outline: none;
            border-color: #e7fe00;
        }
        .now-playing {
            background: linear-gradient(135deg, #2a4a2a, #1a3a2a);
            border: 1px solid #3a5a3a;
            border-radius: 12px;
            padding: 12px 16px;
            margin: 12px 0;
            font-size: 0.85rem;
        }
        .now-playing-label {
            opacity: 0.7;
            font-size: 0.75rem;
            margin-bottom: 4px;
        }
        .now-playing-title {
            font-weight: 600;
        }
        .song-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .song-btn {
            display: flex;
            align-items: center;
            width: 100%;
            padding: 16px;
            background: linear-gradient(135deg, #2a2a4a 0%, #1e1e3a 100%);
            border: 1px solid #3a3a5a;
            border-radius: 12px;
            color: #fff;
            text-align: left;
            cursor: pointer;
            transition: all 0.15s;
            gap: 12px;
        }
        .song-btn:hover {
            border-color: #5a5a7a;
        }
        .song-btn:active {
            transform: scale(0.98);
            background: linear-gradient(135deg, #3a3a5a 0%, #2a2a4a 100%);
        }
        .song-btn.loading {
            opacity: 0.5;
            pointer-events: none;
        }
        .song-btn.success {
            border-color: #00ff88;
            background: linear-gradient(135deg, #1a3a2a 0%, #1a2a3a 100%);
        }
        .song-btn.is-playing {
            border-color: #e7fe00;
            background: linear-gradient(135deg, #3a3a1a 0%, #2a2a1a 100%);
        }
        .song-icon {
            font-size: 1.5rem;
            width: 40px;
            text-align: center;
            flex-shrink: 0;
        }
        .song-info {
            flex: 1;
            min-width: 0;
        }
        .song-title {
            font-size: 1rem;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .song-artist {
            font-size: 0.8rem;
            opacity: 0.6;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .song-duration {
            font-size: 0.75rem;
            opacity: 0.5;
            flex-shrink: 0;
        }
        .song-badge {
            font-size: 0.7rem;
            padding: 2px 8px;
            background: #e7fe00;
            color: #1a1a2e;
            border-radius: 10px;
            font-weight: 600;
            flex-shrink: 0;
        }
        .empty {
            text-align: center;
            padding: 40px 20px;
            opacity: 0.6;
        }
        .loading-spinner {
            text-align: center;
            padding: 60px 20px;
            font-size: 2rem;
            animation: pulse 1s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .toast {
            position: fixed;
            bottom: 30px;
            left: 50%;
            transform: translateX(-50%) translateY(100px);
            background: #00ff88;
            color: #1a1a2e;
            padding: 14px 28px;
            border-radius: 30px;
            font-weight: 600;
            font-size: 0.95rem;
            z-index: 100;
            transition: transform 0.3s ease;
            white-space: nowrap;
            max-width: 90%;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .toast.show {
            transform: translateX(-50%) translateY(0);
        }
        .toast.error {
            background: #ff4466;
            color: #fff;
        }
        .category-header {
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            opacity: 0.5;
            margin: 16px 0 8px;
            padding-left: 4px;
        }
        .category-header:first-child {
            margin-top: 0;
        }
        .hidden { display: none !important; }
        
        /* Pull to refresh indicator */
        .refresh-hint {
            text-align: center;
            font-size: 0.75rem;
            opacity: 0.4;
            padding: 8px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎛️ DJ Override</h1>
        <p class="subtitle">Tap any song to play</p>
        
        <div class="controls">
            <button class="mode-btn active" data-mode="next">▶️ After current</button>
            <button class="mode-btn" data-mode="now">⚡ Interrupt now</button>
        </div>
        
        <div class="search-wrap">
            <input type="text" class="search" placeholder="🔍 Search songs..." id="search">
        </div>
    </div>
    
    <div class="now-playing" id="nowPlaying" style="display:none;">
        <div class="now-playing-label">NOW PLAYING</div>
        <div class="now-playing-title" id="nowPlayingTitle">—</div>
    </div>
    
    <div id="songList" class="song-list">
        <div class="loading-spinner">🎵</div>
    </div>
    
    <p class="refresh-hint">Pull down to refresh • Auto-updates every 30s</p>
    
    <div class="toast" id="toast"></div>
    
    <script>
    (function() {
        let songs = [];
        let currentMode = 'next';
        let playingNow = '';
        
        const songListEl = document.getElementById('songList');
        const searchEl = document.getElementById('search');
        const toast = document.getElementById('toast');
        const nowPlayingEl = document.getElementById('nowPlaying');
        const nowPlayingTitle = document.getElementById('nowPlayingTitle');
        const modeBtns = document.querySelectorAll('.mode-btn');
        
        // Mode toggle
        modeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                modeBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentMode = btn.dataset.mode;
            });
        });
        
        // Search filter
        searchEl.addEventListener('input', () => {
            const query = searchEl.value.toLowerCase().trim();
            document.querySelectorAll('.song-btn').forEach(btn => {
                const title = btn.dataset.display.toLowerCase();
                const artist = (btn.dataset.artist || '').toLowerCase();
                const match = title.includes(query) || artist.includes(query);
                btn.classList.toggle('hidden', !match);
            });
            
            // Also hide empty category headers
            document.querySelectorAll('.category-header').forEach(header => {
                const nextSibling = header.nextElementSibling;
                let hasVisibleSongs = false;
                let el = nextSibling;
                while (el && !el.classList.contains('category-header')) {
                    if (el.classList.contains('song-btn') && !el.classList.contains('hidden')) {
                        hasVisibleSongs = true;
                        break;
                    }
                    el = el.nextElementSibling;
                }
                header.classList.toggle('hidden', !hasVisibleSongs);
            });
        });
        
        // Toast helper
        function showToast(msg, isError) {
            toast.textContent = msg;
            toast.className = 'toast show' + (isError ? ' error' : '');
            setTimeout(() => toast.classList.remove('show'), 2500);
        }
        
        // Format duration
        function formatDuration(seconds) {
            if (!seconds) return '';
            const m = Math.floor(seconds / 60);
            const s = Math.round(seconds % 60);
            return m + ':' + String(s).padStart(2, '0');
        }
        
        // Fetch songs from RF API
        async function loadSongs() {
            try {
                const res = await fetch('/wp-json/rf/v1/showDetails');
                const data = await res.json();
                
                if (data.sequences) {
                    songs = data.sequences
                        .filter(s => s.active && s.visible)
                        .sort((a, b) => {
                            const aName = (a.displayName || a.name).toLowerCase();
                            const bName = (b.displayName || b.name).toLowerCase();
                            return aName.localeCompare(bName);
                        });
                }
                
                playingNow = data.playingNow || '';
                
                renderSongs();
                updateNowPlaying();
                
            } catch (err) {
                console.error('Failed to load songs:', err);
                songListEl.innerHTML = '<div class="empty">Failed to load songs. Pull to retry.</div>';
            }
        }
        
        // Update now playing display
        function updateNowPlaying() {
            if (playingNow && !/intermission/i.test(playingNow)) {
                const song = songs.find(s => s.name === playingNow);
                nowPlayingTitle.textContent = song ? (song.displayName || song.name) : playingNow;
                nowPlayingEl.style.display = 'block';
                
                // Update the playing badge in the list
                document.querySelectorAll('.song-btn').forEach(btn => {
                    const isPlaying = btn.dataset.sequence === playingNow;
                    btn.classList.toggle('is-playing', isPlaying);
                    
                    // Update icon and badge
                    const iconEl = btn.querySelector('.song-icon');
                    const existingBadge = btn.querySelector('.song-badge');
                    
                    if (isPlaying) {
                        if (iconEl) iconEl.textContent = '🔊';
                        if (!existingBadge) {
                            const badge = document.createElement('span');
                            badge.className = 'song-badge';
                            badge.textContent = 'PLAYING';
                            btn.appendChild(badge);
                        }
                    } else {
                        if (iconEl) iconEl.textContent = '🎵';
                        if (existingBadge) existingBadge.remove();
                    }
                });
            } else {
                nowPlayingEl.style.display = 'none';
            }
        }
        
        // Render song list
        function renderSongs() {
            if (!songs.length) {
                songListEl.innerHTML = '<div class="empty">No songs available</div>';
                return;
            }
            
            // Group by category
            const categories = {};
            songs.forEach(song => {
                const cat = song.category || 'Other';
                if (!categories[cat]) categories[cat] = [];
                categories[cat].push(song);
            });
            
            // Sort categories: Christmas first, then alphabetical, Other last
            const catOrder = Object.keys(categories).sort((a, b) => {
                if (a === 'Christmas') return -1;
                if (b === 'Christmas') return 1;
                if (a === 'Other') return 1;
                if (b === 'Other') return -1;
                return a.localeCompare(b);
            });
            
            let html = '';
            
            catOrder.forEach(cat => {
                html += `<div class="category-header">${escapeHtml(cat)}</div>`;
                
                categories[cat].forEach(song => {
                    const isPlaying = song.name === playingNow;
                    const displayName = song.displayName || song.name;
                    const artist = song.artist || '';
                    
                    html += `
                        <button class="song-btn ${isPlaying ? 'is-playing' : ''}" 
                                data-sequence="${escapeAttr(song.name)}"
                                data-display="${escapeAttr(displayName)}"
                                data-artist="${escapeAttr(artist)}">
                            <span class="song-icon">${isPlaying ? '🔊' : '🎵'}</span>
                            <div class="song-info">
                                <div class="song-title">${escapeHtml(displayName)}</div>
                                ${artist ? `<div class="song-artist">${escapeHtml(artist)}</div>` : ''}
                            </div>
                            ${song.duration ? `<span class="song-duration">${formatDuration(song.duration)}</span>` : ''}
                            ${isPlaying ? '<span class="song-badge">PLAYING</span>' : ''}
                        </button>
                    `;
                });
            });
            
            songListEl.innerHTML = html;
            
            // Attach click handlers
            document.querySelectorAll('.song-btn').forEach(btn => {
                btn.addEventListener('click', () => handleSongTap(btn));
            });
        }
        
        // Handle song tap
        async function handleSongTap(btn) {
            const sequence = btn.dataset.sequence;
            const displayName = btn.dataset.display;
            
            btn.classList.add('loading');
            
            try {
                const res = await fetch('/wp-content/themes/integrations/lof-vip-override.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ sequence, mode: currentMode })
                });
                
                const data = await res.json();
                
                if (data.success) {
                    btn.classList.add('success');
                    const modeMsg = currentMode === 'now' ? '⚡ Playing now!' : '✓ Queued next';
                    showToast(`${modeMsg}`);
                    setTimeout(() => btn.classList.remove('success'), 2000);
                    
                    // Refresh after a moment to update now playing
                    if (currentMode === 'now') {
                        setTimeout(loadSongs, 1500);
                    }
                } else {
                    showToast(data.error || 'Failed to queue', true);
                }
            } catch (err) {
                console.error('VIP override error:', err);
                showToast('Network error', true);
            }
            
            btn.classList.remove('loading');
        }
        
        // Escape helpers
        function escapeHtml(str) {
            if (!str) return '';
            return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        
        function escapeAttr(str) {
            if (!str) return '';
            return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        }
        
        // Initial load
        loadSongs();
        
        // Refresh every 30 seconds to keep "now playing" current
        setInterval(loadSongs, 30000);
        
        // Pull to refresh (simple implementation)
        let touchStartY = 0;
        document.addEventListener('touchstart', e => {
            touchStartY = e.touches[0].clientY;
        });
        document.addEventListener('touchend', e => {
            const touchEndY = e.changedTouches[0].clientY;
            const scrollTop = window.scrollY || document.documentElement.scrollTop;
            
            // If at top of page and pulled down significantly
            if (scrollTop <= 0 && touchEndY - touchStartY > 100) {
                showToast('🔄 Refreshing...');
                loadSongs();
            }
        });
    })();
    </script>
</body>
</html>
