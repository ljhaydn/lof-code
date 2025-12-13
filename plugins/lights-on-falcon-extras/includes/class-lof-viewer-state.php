<?php
/**
 * LOF Viewer State - Unified Endpoint
 * 
 * Combines Remote Falcon + FPP data into a single response
 * with derived state for smart UI rendering.
 * 
 * Endpoint: GET /wp-json/lof/v1/viewer-state
 * 
 * @package Lights_On_Falcon
 * @version 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

class LOF_Viewer_State {

    /** @var string FPP base URL */
    private static $fpp_host = 'http://10.9.7.102';

    /** @var int Cache TTL for FPP calls (seconds) */
    private static $fpp_cache_ttl = 3;

    /** @var int Lockout threshold in seconds (5 minutes) */
    private static $lockout_seconds = 300;

    /** @var int Warning threshold in seconds (15 minutes) */
    private static $warning_seconds = 900;

    /**
     * Initialize the class
     */
    public static function init() {
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
    }

    /**
     * Register REST routes
     */
    public static function register_routes() {
        register_rest_route('lof/v1', '/viewer-state', [
            'methods'             => 'GET',
            'callback'            => [__CLASS__, 'get_viewer_state'],
            'permission_callback' => '__return_true',
        ]);
    }

    /**
     * Main endpoint handler
     */
    public static function get_viewer_state(\WP_REST_Request $request) {
        // Fetch RF data via existing proxy
        $rf_data = self::fetch_rf_data();
        
        // Fetch FPP status
        $fpp_data = self::fetch_fpp_status();

        // Extract RF fields
        $prefs = isset($rf_data['preferences']) ? $rf_data['preferences'] : [];
        $sequences = isset($rf_data['sequences']) && is_array($rf_data['sequences']) ? $rf_data['sequences'] : [];
        $requests = isset($rf_data['requests']) && is_array($rf_data['requests']) ? $rf_data['requests'] : [];
        $rf_playing_now = isset($rf_data['playingNow']) ? $rf_data['playingNow'] : '';
        $viewer_control_enabled = !empty($prefs['viewerControlEnabled']);

        // Extract FPP fields
        $fpp_sequence = isset($fpp_data['current_sequence']) ? $fpp_data['current_sequence'] : '';
        $fpp_song = isset($fpp_data['current_song']) ? $fpp_data['current_song'] : '';
        $fpp_seconds_remaining = isset($fpp_data['seconds_remaining']) ? intval($fpp_data['seconds_remaining']) : 0;
        $fpp_status_name = isset($fpp_data['status_name']) ? $fpp_data['status_name'] : 'idle';
        
        // Scheduler data
        $scheduler = isset($fpp_data['scheduler']) ? $fpp_data['scheduler'] : [];
        $scheduler_status = isset($scheduler['status']) ? $scheduler['status'] : 'idle';
        $current_playlist = isset($scheduler['currentPlaylist']) ? $scheduler['currentPlaylist'] : [];
        $next_playlist = isset($scheduler['nextPlaylist']) ? $scheduler['nextPlaylist'] : [];
        
        $playlist_name = '';
        if (isset($current_playlist['playlistName'])) {
            $playlist_name = $current_playlist['playlistName'];
        } elseif (isset($fpp_data['current_playlist']['playlist'])) {
            $playlist_name = $fpp_data['current_playlist']['playlist'];
        }

        // Derive playlist type
        $is_show_playlist = stripos($playlist_name, 'show') !== false && stripos($playlist_name, 'reset') === false;
        $is_intermission = stripos($playlist_name, 'intermission') !== false;
        $is_reset_playlist = stripos($playlist_name, 'reset') !== false;

        // Calculate time until next hour reset
        $now = time();
        $current_minute = (int) date('i', $now);
        $current_second = (int) date('s', $now);
        $seconds_until_reset = (60 - $current_minute - 1) * 60 + (60 - $current_second);
        if ($seconds_until_reset > 3600) {
            $seconds_until_reset = 3600; // Cap at 1 hour
        }

        // Determine next show time
        $next_hour = (int) date('g', $now);
        $next_hour = $next_hour >= 12 ? $next_hour - 11 : $next_hour + 1;
        $next_ampm = date('A', $now);
        if ($current_minute >= 55) {
            // About to flip to next hour
        }
        $next_show_time = date('g:00 A', strtotime('+1 hour', strtotime(date('Y-m-d H:00:00', $now))));

        // Lockout and warning states
        $is_lockout = $seconds_until_reset <= self::$lockout_seconds;
        $is_warning = $seconds_until_reset <= self::$warning_seconds && !$is_lockout;
        $is_after_hours = !$viewer_control_enabled;

        // Determine mode
        $mode = 'unknown';
        if ($is_after_hours) {
            $mode = 'after_hours';
        } elseif ($is_lockout) {
            $mode = 'lockout';
        } elseif ($is_reset_playlist) {
            $mode = 'resetting';
        } elseif ($is_show_playlist) {
            $mode = count($requests) > 0 ? 'show_queue' : 'show_random';
        } elseif ($is_intermission) {
            $mode = count($requests) > 0 ? 'intermission_queue' : 'intermission_empty';
        } else {
            $mode = count($requests) > 0 ? 'show_queue' : 'show_random';
        }

        // Find current sequence details
        $now_seq = self::find_sequence($sequences, $fpp_sequence, $rf_playing_now);
        
        // Determine if current song was a request
        $is_now_request = self::is_sequence_in_recent_requests($fpp_sequence, $rf_playing_now, $requests, $rf_data);

        // Build now playing info
        $now_info = [
            'sequence'         => $fpp_sequence,
            'displayName'      => $now_seq ? ($now_seq['displayName'] ?: $now_seq['name']) : $rf_playing_now,
            'artist'           => $now_seq ? (isset($now_seq['artist']) ? $now_seq['artist'] : '') : '',
            'secondsRemaining' => $fpp_seconds_remaining,
            'isRequest'        => $is_now_request,
            'isPlaying'        => $fpp_status_name === 'playing' && !empty($fpp_sequence),
        ];

        // Build queue with wait times
        $queue = [];
        $cumulative_wait = $fpp_seconds_remaining;
        
        foreach ($requests as $idx => $req) {
            $seq = isset($req['sequence']) && is_array($req['sequence']) ? $req['sequence'] : [];
            $duration = isset($seq['duration']) ? intval($seq['duration']) : 180; // Default 3 min
            
            $queue[] = [
                'sequence'       => isset($seq['name']) ? $seq['name'] : '',
                'displayName'    => isset($seq['displayName']) ? $seq['displayName'] : (isset($seq['name']) ? $seq['name'] : 'Unknown'),
                'artist'         => isset($seq['artist']) ? $seq['artist'] : '',
                'duration'       => $duration,
                'waitSeconds'    => $cumulative_wait,
                'position'       => $idx + 1,
                'ownerRequested' => !empty($req['ownerRequested']),
            ];
            
            $cumulative_wait += $duration;
        }

        // Build next up info
        $next_up = null;
        if (count($queue) > 0) {
            $next_up = [
                'sequence'    => $queue[0]['sequence'],
                'displayName' => $queue[0]['displayName'],
                'artist'      => $queue[0]['artist'],
                'waitSeconds' => $queue[0]['waitSeconds'],
                'isRequest'   => true,
                'source'      => 'queue',
            ];
        }

        // Determine if requests are allowed
        $requests_allowed = $viewer_control_enabled && !$is_lockout;
        $request_block_reason = null;
        
        if (!$viewer_control_enabled) {
            $request_block_reason = 'after_hours';
        } elseif ($is_lockout) {
            $request_block_reason = 'lockout';
        }

        // Build response
        $response = [
            'now' => $now_info,
            'nextUp' => $next_up,
            'queue' => $queue,
            'state' => [
                'mode'                   => $mode,
                'playlistName'           => $playlist_name,
                'isShowPlaylist'         => $is_show_playlist,
                'isIntermission'         => $is_intermission,
                'isLockout'              => $is_lockout,
                'isWarning'              => $is_warning,
                'isAfterHours'           => $is_after_hours,
                'viewerControlEnabled'   => $viewer_control_enabled,
                'timeUntilResetSeconds'  => $seconds_until_reset,
                'nextShowTime'           => $next_show_time,
                'fppStatus'              => $fpp_status_name,
                'schedulerStatus'        => $scheduler_status,
            ],
            'requests' => [
                'allowed' => $requests_allowed,
                'reason'  => $request_block_reason,
            ],
            // Pass through sequences for song grid
            'sequences'   => $sequences,
            'preferences' => $prefs,
            // Keep raw data for backward compatibility
            'playingNow'  => $rf_playing_now,
            'votes'       => isset($rf_data['votes']) ? $rf_data['votes'] : [],
        ];

        return rest_ensure_response($response);
    }

    /**
     * Fetch RF show details via existing WP proxy
     */
    private static function fetch_rf_data() {
        $opts = get_option('rf_viewer_settings', []);
        $api_base = isset($opts['api_base']) ? $opts['api_base'] : '';
        $jwt = isset($opts['jwt']) ? $opts['jwt'] : '';
        $cache_seconds = isset($opts['cache_seconds']) ? intval($opts['cache_seconds']) : 15;

        if (empty($api_base) || empty($jwt)) {
            return [];
        }

        // Check cache
        $cache_key = 'lof_rf_showdetails';
        if ($cache_seconds > 0) {
            $cached = get_transient($cache_key);
            if ($cached !== false) {
                return $cached;
            }
        }

        $response = wp_remote_get($api_base . '/showDetails', [
            'headers' => [
                'Authorization' => 'Bearer ' . $jwt,
                'Accept'        => 'application/json',
            ],
            'timeout' => 10,
        ]);

        if (is_wp_error($response)) {
            error_log('[LOF Viewer State] RF API error: ' . $response->get_error_message());
            return [];
        }

        $body = wp_remote_retrieve_body($response);
        $data = json_decode($body, true);

        if (json_last_error() !== JSON_ERROR_NONE) {
            error_log('[LOF Viewer State] RF API invalid JSON');
            return [];
        }

        if ($cache_seconds > 0) {
            set_transient($cache_key, $data, $cache_seconds);
        }

        return $data;
    }

    /**
     * Fetch FPP status
     */
    private static function fetch_fpp_status() {
        // Check cache
        $cache_key = 'lof_fpp_status';
        $cached = get_transient($cache_key);
        if ($cached !== false) {
            return $cached;
        }

        $url = rtrim(self::$fpp_host, '/') . '/api/fppd/status';

        $response = wp_remote_get($url, [
            'timeout' => 3,
        ]);

        if (is_wp_error($response)) {
            error_log('[LOF Viewer State] FPP API error: ' . $response->get_error_message());
            return [];
        }

        $body = wp_remote_retrieve_body($response);
        $data = json_decode($body, true);

        if (json_last_error() !== JSON_ERROR_NONE || !is_array($data)) {
            error_log('[LOF Viewer State] FPP API invalid JSON');
            return [];
        }

        set_transient($cache_key, $data, self::$fpp_cache_ttl);

        return $data;
    }

    /**
     * Find sequence object by name
     */
    private static function find_sequence($sequences, $fpp_sequence, $rf_playing_now) {
        if (!is_array($sequences)) {
            return null;
        }

        // Try FPP sequence name first
        if (!empty($fpp_sequence)) {
            foreach ($sequences as $seq) {
                if (isset($seq['name']) && $seq['name'] === $fpp_sequence) {
                    return $seq;
                }
            }
        }

        // Try RF playing now
        if (!empty($rf_playing_now)) {
            foreach ($sequences as $seq) {
                if (isset($seq['name']) && $seq['name'] === $rf_playing_now) {
                    return $seq;
                }
                if (isset($seq['displayName']) && $seq['displayName'] === $rf_playing_now) {
                    return $seq;
                }
            }
        }

        return null;
    }

    /**
     * Determine if currently playing song was from a request
     * 
     * This is tricky - we check if RF's playingNow matches what we expect
     * from a recently played request. RF removes items from requests[] once
     * they start playing, so we can't directly check the array.
     * 
     * Heuristic: If RF playingNow matches FPP current_sequence AND
     * the sequence is in our sequences list, it was likely a request
     * if we're in show mode and queue was recently populated.
     */
    private static function is_sequence_in_recent_requests($fpp_sequence, $rf_playing_now, $requests, $rf_data) {
        // If there are items still in queue, current song was likely a request
        // (RF removes playing item from requests, but leaves the rest)
        
        // Simple heuristic: check if RF reports it as playingNow and it matches FPP
        // This means RF knows about it (i.e., it was requested through RF)
        if (!empty($rf_playing_now) && $rf_playing_now === $fpp_sequence) {
            // Check if playingNext exists - if so, there's a queue concept active
            if (!empty($rf_data['playingNext']) || count($requests) > 0) {
                return true;
            }
        }

        // Conservative default: if we can't determine, assume it's from playlist
        // This prevents false "Requested by a guest" labels
        return false;
    }

    /**
     * Check if a specific song can play before reset
     * 
     * @param int $song_duration Duration of song in seconds
     * @param int $current_wait Current queue wait time
     * @param int $time_until_reset Seconds until next reset
     * @return array ['allowed' => bool, 'reason' => string|null]
     */
    public static function can_song_play($song_duration, $current_wait, $time_until_reset) {
        // Hard lockout
        if ($time_until_reset < self::$lockout_seconds) {
            return [
                'allowed' => false,
                'reason'  => 'lockout',
            ];
        }

        // Calculate if song will finish in time (with 60s buffer)
        $total_time = $current_wait + $song_duration + 60;
        
        if ($total_time > $time_until_reset) {
            return [
                'allowed' => false,
                'reason'  => 'not_enough_time',
                'details' => [
                    'needed'    => $total_time,
                    'available' => $time_until_reset,
                ],
            ];
        }

        return [
            'allowed' => true,
            'reason'  => null,
        ];
    }
}
