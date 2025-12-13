<?php
/**
 * LOF Viewer State - Unified Endpoint (V1.5 Corrected)
 * 
 * Combines Remote Falcon + FPP Status + FPP Schedule into a single response
 * with properly derived state for smart UI rendering.
 * 
 * Data Sources:
 * - /api/fppd/status   (real-time): Current playlist, song, time remaining
 * - /api/fppd/schedule (config):    Upcoming resets, show times, intermission windows
 * - RF API             (real-time): Queue, viewer control, sequences
 * 
 * Endpoint: GET /wp-json/lof/v1/viewer-state
 * 
 * @package Lights_On_Falcon
 * @version 1.5.0
 */

if (!defined('ABSPATH')) {
    exit;
}

class LOF_Viewer_State {

    /** @var string FPP base URL */
    private static $fpp_host = 'http://10.9.7.102';

    /** @var int Cache TTL for FPP status calls (seconds) */
    private static $fpp_status_cache_ttl = 3;

    /** @var int Cache TTL for FPP schedule calls (seconds) - longer since it's config */
    private static $fpp_schedule_cache_ttl = 60;

    /** @var int Lockout threshold in seconds (5 minutes before reset) */
    private static $lockout_seconds = 300;

    /** @var int Warning threshold in seconds (15 minutes before reset) */
    private static $warning_seconds = 900;

    /** @var int Default song duration estimate for queue lockout calc */
    private static $default_song_duration = 180;

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
        $now = time();
        
        // Fetch all data sources
        $rf_data = self::fetch_rf_data();
        $fpp_status = self::fetch_fpp_status();
        $fpp_schedule = self::fetch_fpp_schedule();

        // Extract RF fields
        $prefs = isset($rf_data['preferences']) ? $rf_data['preferences'] : [];
        $sequences = isset($rf_data['sequences']) && is_array($rf_data['sequences']) ? $rf_data['sequences'] : [];
        $requests = isset($rf_data['requests']) && is_array($rf_data['requests']) ? $rf_data['requests'] : [];
        $rf_playing_now = isset($rf_data['playingNow']) ? $rf_data['playingNow'] : '';
        $rf_playing_next = isset($rf_data['playingNext']) ? $rf_data['playingNext'] : '';
        $viewer_control_enabled = !empty($prefs['viewerControlEnabled']);

        // Extract FPP Status fields (real-time)
        $fpp_online = isset($fpp_status['fppd']) && $fpp_status['fppd'] === 'running';
        $fpp_sequence = isset($fpp_status['current_sequence']) ? $fpp_status['current_sequence'] : '';
        $fpp_seconds_remaining = isset($fpp_status['seconds_remaining']) ? intval($fpp_status['seconds_remaining']) : 0;
        $fpp_status_name = isset($fpp_status['status_name']) ? $fpp_status['status_name'] : 'idle';
        
        // Scheduler data from status (real-time)
        $scheduler = isset($fpp_status['scheduler']) ? $fpp_status['scheduler'] : [];
        $scheduler_status = isset($scheduler['status']) ? $scheduler['status'] : 'idle';
        $current_playlist_data = isset($scheduler['currentPlaylist']) ? $scheduler['currentPlaylist'] : [];
        
        // Get current playlist name (prefer scheduler, fallback to current_playlist)
        $playlist_name = '';
        if (isset($current_playlist_data['playlistName'])) {
            $playlist_name = $current_playlist_data['playlistName'];
        } elseif (isset($fpp_status['current_playlist']['playlist'])) {
            $playlist_name = $fpp_status['current_playlist']['playlist'];
        }

        // Parse schedule to find upcoming events
        $schedule_info = self::parse_schedule($fpp_schedule, $now);

        // Derive playlist type from name (case-insensitive substring match)
        $playlist_lower = strtolower($playlist_name);
        $is_reset_playlist = strpos($playlist_lower, 'reset') !== false;
        $is_show_playlist = strpos($playlist_lower, 'show') !== false && !$is_reset_playlist;
        $is_intermission = strpos($playlist_lower, 'intermission') !== false;

        // Determine if we're in show hours (based on intermission schedule window)
        $is_show_hours = $schedule_info['isShowHours'];
        
        // Is testing mode? (scheduler not driving, someone manually started playlist)
        $is_test_mode = $scheduler_status === 'manual';

        // Calculate time until next reset
        $time_until_reset = $schedule_info['timeUntilResetSeconds'];
        
        // Lockout logic
        $is_time_lockout = $is_show_hours && $time_until_reset !== null && $time_until_reset <= self::$lockout_seconds;
        $is_time_warning = $is_show_hours && $time_until_reset !== null && $time_until_reset <= self::$warning_seconds && !$is_time_lockout;
        
        // Queue-based lockout: would a new song finish before reset?
        $queue_duration = self::calculate_queue_duration($requests);
        $is_queue_lockout = false;
        
        if ($is_show_hours && $time_until_reset !== null && !$is_time_lockout) {
            $total_with_new_song = $fpp_seconds_remaining + $queue_duration + self::$default_song_duration + 60; // 60s buffer
            if ($total_with_new_song > $time_until_reset) {
                $is_queue_lockout = true;
            }
        }

        // Combined lockout
        $is_lockout = $is_time_lockout || $is_queue_lockout;
        $lockout_reason = null;
        if ($is_time_lockout) {
            $lockout_reason = 'time';
        } elseif ($is_queue_lockout) {
            $lockout_reason = 'queue';
        }

        // Determine after hours (not in show hours and nothing playing OR viewer control disabled)
        $is_playing = $fpp_status_name === 'playing' && !empty($fpp_sequence);
        $is_after_hours = !$is_show_hours && !$is_playing && !$is_test_mode;
        
        // Override: if viewer control is disabled by RF, treat as after hours (unless testing)
        if (!$viewer_control_enabled && !$is_test_mode) {
            $is_after_hours = true;
        }

        // Determine pre-show state (before lights open, but show is coming)
        $has_upcoming_lights = $schedule_info['nextLightsOpenTime'] !== null || $schedule_info['nextShowStartTime'] !== null;
        $is_preshow = !$is_show_hours && !$is_after_hours && !$is_playing && $has_upcoming_lights;

        // Determine the show state mode
        $mode = self::determine_mode(
            $is_after_hours,
            $is_preshow,
            $is_reset_playlist,
            $is_show_playlist,
            $is_intermission,
            $is_lockout,
            $lockout_reason,
            count($requests)
        );

        // Find current sequence details
        $now_seq = self::find_sequence($sequences, $fpp_sequence, $rf_playing_now);
        
        // Determine if current song was a request
        $is_now_request = self::is_sequence_in_recent_requests($fpp_sequence, $rf_playing_now, $requests, $rf_data);

        // Build now playing info
        $now_info = [
            'sequence'         => $fpp_sequence,
            'displayName'      => $now_seq ? ($now_seq['displayName'] ?: $now_seq['name']) : ($rf_playing_now ?: ''),
            'artist'           => $now_seq ? (isset($now_seq['artist']) ? $now_seq['artist'] : '') : '',
            'secondsRemaining' => $fpp_seconds_remaining,
            'isRequest'        => $is_now_request,
            'isPlaying'        => $is_playing,
        ];

        // Build queue with wait times
        $queue = [];
        $cumulative_wait = $fpp_seconds_remaining;
        
        foreach ($requests as $idx => $req) {
            $seq = isset($req['sequence']) && is_array($req['sequence']) ? $req['sequence'] : [];
            $duration = isset($seq['duration']) ? intval($seq['duration']) : self::$default_song_duration;
            
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
        } elseif (!empty($rf_playing_next)) {
            // RF has a playingNext that's not from queue
            $next_seq = self::find_sequence($sequences, $rf_playing_next, $rf_playing_next);
            $next_up = [
                'sequence'    => $rf_playing_next,
                'displayName' => $next_seq ? ($next_seq['displayName'] ?: $next_seq['name']) : $rf_playing_next,
                'artist'      => $next_seq ? (isset($next_seq['artist']) ? $next_seq['artist'] : '') : '',
                'waitSeconds' => $fpp_seconds_remaining,
                'isRequest'   => false,
                'source'      => 'playlist',
            ];
        }

        // Determine if requests are allowed
        $requests_allowed = $viewer_control_enabled && !$is_lockout && !$is_after_hours && !$is_preshow && !$is_reset_playlist;
        
        // In test mode, allow requests if RF says OK
        if ($is_test_mode && $viewer_control_enabled && !$is_lockout) {
            $requests_allowed = true;
        }
        
        $request_block_reason = null;
        
        if ($is_after_hours && !$is_test_mode) {
            $request_block_reason = 'after_hours';
        } elseif ($is_preshow) {
            $request_block_reason = 'preshow';
        } elseif ($is_reset_playlist) {
            $request_block_reason = 'resetting';
        } elseif (!$viewer_control_enabled) {
            $request_block_reason = 'viewer_control_off';
        } elseif ($is_time_lockout) {
            $request_block_reason = 'time_lockout';
        } elseif ($is_queue_lockout) {
            $request_block_reason = 'queue_lockout';
        }

        // Format next show time for display (first reset, e.g., 6 PM)
        $next_show_display = self::format_next_show_time($schedule_info, $now);
        
        // Format next lights open time for display (viewer control on, e.g., 5 PM)
        $next_lights_display = self::format_next_lights_time($schedule_info, $now);

        // Build response
        $response = [
            'now' => $now_info,
            'nextUp' => $next_up,
            'queue' => $queue,
            'queueDurationSeconds' => $queue_duration,
            'state' => [
                'mode'                   => $mode,
                'playlistName'           => $playlist_name,
                'isShowPlaylist'         => $is_show_playlist,
                'isIntermission'         => $is_intermission,
                'isReset'                => $is_reset_playlist,
                'isShowHours'            => $is_show_hours,
                'isTestMode'             => $is_test_mode,
                'isLockout'              => $is_lockout,
                'lockoutReason'          => $lockout_reason,
                'isWarning'              => $is_time_warning,
                'isAfterHours'           => $is_after_hours,
                'isPreshow'              => $is_preshow,
                'viewerControlEnabled'   => $viewer_control_enabled,
                'timeUntilResetSeconds'  => $time_until_reset,
                'nextResetTime'          => $schedule_info['nextResetTimeDisplay'],
                'nextLightsOpenTime'     => $next_lights_display,   // When requests open (5 PM)
                'nextShowTime'           => $next_show_display,     // When first show/reset runs (6 PM)
                'showEndsAt'             => $schedule_info['showEndsAtDisplay'],
                'fppStatus'              => $fpp_status_name,
                'fppOnline'              => $fpp_online,
                'schedulerStatus'        => $scheduler_status,
            ],
            'requestsAllowed' => [
                'allowed' => $requests_allowed,
                'reason'  => $request_block_reason,
            ],
            // Pass through for backward compatibility
            'sequences'   => $sequences,
            'preferences' => $prefs,
            'requests'    => $requests,  // RF's raw queue array - JS needs this for renderQueue()
            'playingNow'  => $rf_playing_now,
            'playingNext' => $rf_playing_next,
            'votes'       => isset($rf_data['votes']) ? $rf_data['votes'] : [],
        ];

        return rest_ensure_response($response);
    }

    /**
     * Parse FPP schedule to extract upcoming events
     * 
     * Looks for:
     * - Intermission playlists to determine show hours window
     * - Reset playlists to calculate lockout timing
     * - Show playlists for "next show" messaging
     * 
     * @param array $fpp_schedule Raw schedule data from /api/fppd/schedule
     * @param int $now Current Unix timestamp
     * @return array Parsed schedule info
     */
    private static function parse_schedule($fpp_schedule, $now) {
        $result = [
            'isShowHours'             => false,
            'timeUntilResetSeconds'   => null,
            'nextResetTime'           => null,
            'nextResetTimeDisplay'    => null,
            'nextLightsOpenTime'      => null,      // When viewer control turns on (5 PM)
            'nextLightsOpenDisplay'   => null,
            'nextLightsOpenTimeStr'   => null,
            'nextShowStartTime'       => null,      // When first reset/show runs (6 PM)
            'nextShowStartDisplay'    => null,
            'nextShowStartTimeStr'    => null,
            'showEndsAt'              => null,
            'showEndsAtDisplay'       => null,
            'currentIntermission'     => null,
        ];

        // Check for schedule items (the projected upcoming events)
        $items = [];
        if (isset($fpp_schedule['schedule']['items']) && is_array($fpp_schedule['schedule']['items'])) {
            $items = $fpp_schedule['schedule']['items'];
        }

        if (empty($items)) {
            // Fallback: use time-of-day heuristic
            return self::fallback_schedule_detection($now);
        }

        $next_reset = null;
        $next_lights_open = null;
        $current_intermission_end = null;

        foreach ($items as $item) {
            $start_time = isset($item['startTime']) ? intval($item['startTime']) : 0;
            $end_time = isset($item['endTime']) ? intval($item['endTime']) : 0;
            
            // CRITICAL: Use FPP's pre-formatted strings to avoid timezone issues
            // FPP returns "Sat Dec 13 @ 05:00 PM" which is already in local time
            $start_time_str = isset($item['startTimeStr']) ? $item['startTimeStr'] : '';
            $end_time_str = isset($item['endTimeStr']) ? $item['endTimeStr'] : '';
            
            // Get playlist/command name from args[0] or playlist field
            $name = '';
            if (isset($item['args']) && is_array($item['args']) && count($item['args']) > 0) {
                $name = $item['args'][0];
            } elseif (isset($item['playlist'])) {
                $name = $item['playlist'];
            }
            
            $name_lower = strtolower($name);

            // Viewer Control On = when lights & requests open (5 PM)
            $is_viewer_control_on = strpos($name_lower, 'viewer control') !== false && strpos($name_lower, 'on') !== false;
            
            // Intermission = show hours window
            $is_intermission = strpos($name_lower, 'intermission') !== false;
            
            // Either defines "show hours" for the UI
            $is_show_window = $is_viewer_control_on || $is_intermission;
            
            if ($is_show_window) {
                if ($start_time <= $now && $end_time > $now) {
                    $result['isShowHours'] = true;
                    $result['currentIntermission'] = $item;
                    $current_intermission_end = $end_time;
                    $result['showEndsAt'] = $end_time;
                    $result['showEndsAtDisplay'] = self::format_time_display($end_time_str);
                }
                
                // Track next lights open time (Viewer Control On)
                if ($is_viewer_control_on && $start_time > $now && $next_lights_open === null) {
                    $next_lights_open = $start_time;
                    $result['nextLightsOpenTime'] = $start_time;
                    $result['nextLightsOpenDisplay'] = self::format_time_display($start_time_str);
                    $result['nextLightsOpenTimeStr'] = $start_time_str;
                }
            }

            // Find next reset (first one after now) - THIS is when the "show" actually starts
            if (strpos($name_lower, 'reset') !== false && $start_time > $now) {
                if ($next_reset === null || $start_time < $next_reset) {
                    $next_reset = $start_time;
                    $result['nextResetTime'] = $start_time;
                    $result['nextResetTimeDisplay'] = self::format_time_display($start_time_str);
                    // First reset = show start time
                    if ($result['nextShowStartTime'] === null) {
                        $result['nextShowStartTime'] = $start_time;
                        $result['nextShowStartDisplay'] = self::format_time_display($start_time_str);
                        $result['nextShowStartTimeStr'] = $start_time_str;
                    }
                }
            }
        }

        // Calculate time until reset
        if ($next_reset !== null) {
            $result['timeUntilResetSeconds'] = $next_reset - $now;
        }

        return $result;
    }

    /**
     * Fallback schedule detection using time-of-day heuristics
     * Used when FPP schedule is unavailable
     */
    private static function fallback_schedule_detection($now) {
        $hour = (int) date('G', $now);
        $minute = (int) date('i', $now);
        $day_of_week = (int) date('w', $now); // 0 = Sunday, 6 = Saturday
        
        $is_weekend = in_array($day_of_week, [0, 5, 6]); // Fri, Sat, Sun
        $lights_open = 17; // 5 PM - when lights & requests open
        $show_start = 18;  // 6 PM - when first reset/show runs
        $show_end = $is_weekend ? 24 : 23; // Midnight on weekends, 11 PM otherwise

        $is_show_hours = $hour >= $lights_open && $hour < $show_end;

        // Estimate next reset at the top of next hour
        $seconds_until_next_hour = (60 - $minute) * 60 - (int) date('s', $now);
        
        // Next lights open time (5 PM)
        $next_lights_timestamp = null;
        if ($hour < $lights_open) {
            $next_lights_timestamp = strtotime(date('Y-m-d', $now) . ' 17:00:00');
        } else {
            $next_lights_timestamp = strtotime(date('Y-m-d', $now + 86400) . ' 17:00:00');
        }
        
        // Next show time (6 PM - first reset)
        $next_show_timestamp = null;
        if ($hour < $show_start) {
            $next_show_timestamp = strtotime(date('Y-m-d', $now) . ' 18:00:00');
        } else {
            $next_show_timestamp = strtotime(date('Y-m-d', $now + 86400) . ' 18:00:00');
        }

        return [
            'isShowHours'             => $is_show_hours,
            'timeUntilResetSeconds'   => $is_show_hours ? $seconds_until_next_hour : null,
            'nextResetTime'           => $is_show_hours ? $now + $seconds_until_next_hour : null,
            'nextResetTimeDisplay'    => $is_show_hours ? date('g:i A', $now + $seconds_until_next_hour) : null,
            'nextLightsOpenTime'      => $next_lights_timestamp,
            'nextLightsOpenDisplay'   => date('g A', $next_lights_timestamp),
            'nextLightsOpenTimeStr'   => null,
            'nextShowStartTime'       => $next_show_timestamp,
            'nextShowStartDisplay'    => date('g A', $next_show_timestamp),
            'nextShowStartTimeStr'    => null,
            'showEndsAt'              => null,
            'showEndsAtDisplay'       => null,
            'currentIntermission'     => null,
            '_fallback'               => true,
        ];
    }

    /**
     * Extract time portion from FPP's startTimeStr/endTimeStr
     * 
     * FPP format: "Sat Dec 13 @ 05:00 PM" or "Sun @ 20:45:00"
     * We extract just the time: "5:00 PM" or "8:45 PM"
     * 
     * @param string $fpp_time_str The startTimeStr/endTimeStr from FPP
     * @return string|null Formatted time for display
     */
    private static function format_time_display($fpp_time_str) {
        if (empty($fpp_time_str)) return null;
        
        // Pattern 1: "Sat Dec 13 @ 05:00 PM" - has AM/PM
        if (preg_match('/@\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i', $fpp_time_str, $matches)) {
            return trim($matches[1]);
        }
        
        // Pattern 2: "Sun @ 20:45:00" - 24-hour format
        if (preg_match('/@\s*(\d{1,2}):(\d{2})(?::\d{2})?/', $fpp_time_str, $matches)) {
            $hour = intval($matches[1]);
            $minute = $matches[2];
            
            if ($hour == 0) return "12:{$minute} AM";
            if ($hour < 12) return "{$hour}:{$minute} AM";
            if ($hour == 12) return "12:{$minute} PM";
            return ($hour - 12) . ":{$minute} PM";
        }
        
        // Fallback: return as-is
        return $fpp_time_str;
    }

    /**
     * Format next show time with today/tomorrow logic
     * Uses FPP's startTimeStr to determine day (avoids timezone issues)
     */
    private static function format_next_show_time($schedule_info, $now) {
        if (empty($schedule_info['nextShowStartTime'])) {
            return '5pm';
        }

        // Get the formatted time from FPP's string
        $time_str = isset($schedule_info['nextShowStartDisplay']) ? $schedule_info['nextShowStartDisplay'] : null;
        if (!$time_str) {
            return '5pm';
        }
        
        // Use FPP's full string to determine if today/tomorrow
        $fpp_str = isset($schedule_info['nextShowStartTimeStr']) ? $schedule_info['nextShowStartTimeStr'] : '';
        
        if (!empty($fpp_str)) {
            $today_day = strtolower(date('D', $now));      // e.g., "sat"
            $tomorrow_day = strtolower(date('D', $now + 86400)); // e.g., "sun"
            $fpp_lower = strtolower($fpp_str);
            
            // Check if FPP string contains today's day name
            if (strpos($fpp_lower, $today_day) !== false) {
                return $time_str;
            }
            
            // Check if FPP string contains tomorrow's day name
            if (strpos($fpp_lower, $tomorrow_day) !== false) {
                return $time_str . ' tomorrow';
            }
            
            // Extract day name from FPP string for other days
            if (preg_match('/^(\w+)/', $fpp_str, $matches)) {
                $days = ['Sun'=>'Sunday','Mon'=>'Monday','Tue'=>'Tuesday','Wed'=>'Wednesday','Thu'=>'Thursday','Fri'=>'Friday','Sat'=>'Saturday'];
                $day = ucfirst(strtolower($matches[1]));
                if (isset($days[$day])) $day = $days[$day];
                return $day . ' at ' . $time_str;
            }
        }
        
        return $time_str;
    }

    /**
     * Format next lights open time with today/tomorrow logic
     * Uses FPP's startTimeStr to determine day (avoids timezone issues)
     */
    private static function format_next_lights_time($schedule_info, $now) {
        if (empty($schedule_info['nextLightsOpenTime'])) {
            return null;
        }

        // Get the formatted time from FPP's string
        $time_str = isset($schedule_info['nextLightsOpenDisplay']) ? $schedule_info['nextLightsOpenDisplay'] : null;
        if (!$time_str) {
            return null;
        }
        
        // Use FPP's full string to determine if today/tomorrow
        $fpp_str = isset($schedule_info['nextLightsOpenTimeStr']) ? $schedule_info['nextLightsOpenTimeStr'] : '';
        
        if (!empty($fpp_str)) {
            $today_day = strtolower(date('D', $now));      // e.g., "sat"
            $tomorrow_day = strtolower(date('D', $now + 86400)); // e.g., "sun"
            $fpp_lower = strtolower($fpp_str);
            
            // Check if FPP string contains today's day name
            if (strpos($fpp_lower, $today_day) !== false) {
                return $time_str;
            }
            
            // Check if FPP string contains tomorrow's day name
            if (strpos($fpp_lower, $tomorrow_day) !== false) {
                return $time_str . ' tomorrow';
            }
            
            // Extract day name from FPP string for other days
            if (preg_match('/^(\w+)/', $fpp_str, $matches)) {
                $days = ['Sun'=>'Sunday','Mon'=>'Monday','Tue'=>'Tuesday','Wed'=>'Wednesday','Thu'=>'Thursday','Fri'=>'Friday','Sat'=>'Saturday'];
                $day = ucfirst(strtolower($matches[1]));
                if (isset($days[$day])) $day = $days[$day];
                return $day . ' at ' . $time_str;
            }
        }
        
        return $time_str;
    }

    /**
     * Calculate total duration of queued songs
     */
    private static function calculate_queue_duration($requests) {
        $total = 0;
        foreach ($requests as $req) {
            $seq = isset($req['sequence']) && is_array($req['sequence']) ? $req['sequence'] : [];
            $duration = isset($seq['duration']) ? intval($seq['duration']) : self::$default_song_duration;
            $total += $duration;
        }
        return $total;
    }

    /**
     * Determine the UI mode based on state
     */
    private static function determine_mode($is_after_hours, $is_preshow, $is_reset, $is_show, $is_intermission, $is_lockout, $lockout_reason, $queue_count) {
        if ($is_after_hours) {
            return 'after_hours';
        }
        
        if ($is_preshow) {
            return 'preshow';
        }
        
        if ($is_reset) {
            return 'resetting';
        }

        if ($is_lockout) {
            if ($lockout_reason === 'queue') {
                return 'queue_lockout';
            }
            return 'time_lockout';
        }

        if ($is_show) {
            return $queue_count > 0 ? 'show_queue' : 'show_random';
        }

        if ($is_intermission) {
            return $queue_count > 0 ? 'intermission_queue' : 'intermission_empty';
        }

        return 'unknown';
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
     * Fetch FPP status (real-time)
     */
    private static function fetch_fpp_status() {
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
            error_log('[LOF Viewer State] FPP Status API error: ' . $response->get_error_message());
            return [];
        }

        $body = wp_remote_retrieve_body($response);
        $data = json_decode($body, true);

        if (json_last_error() !== JSON_ERROR_NONE || !is_array($data)) {
            error_log('[LOF Viewer State] FPP Status API invalid JSON');
            return [];
        }

        set_transient($cache_key, $data, self::$fpp_status_cache_ttl);

        return $data;
    }

    /**
     * Fetch FPP schedule (config - changes less frequently)
     */
    private static function fetch_fpp_schedule() {
        $cache_key = 'lof_fpp_schedule';
        $cached = get_transient($cache_key);
        if ($cached !== false) {
            return $cached;
        }

        $url = rtrim(self::$fpp_host, '/') . '/api/fppd/schedule';

        $response = wp_remote_get($url, [
            'timeout' => 5,
        ]);

        if (is_wp_error($response)) {
            error_log('[LOF Viewer State] FPP Schedule API error: ' . $response->get_error_message());
            return [];
        }

        $body = wp_remote_retrieve_body($response);
        $data = json_decode($body, true);

        if (json_last_error() !== JSON_ERROR_NONE || !is_array($data)) {
            error_log('[LOF Viewer State] FPP Schedule API invalid JSON');
            return [];
        }

        set_transient($cache_key, $data, self::$fpp_schedule_cache_ttl);

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
     */
    private static function is_sequence_in_recent_requests($fpp_sequence, $rf_playing_now, $requests, $rf_data) {
        // If RF reports it as playingNow and it matches FPP, and there's queue activity, likely a request
        if (!empty($rf_playing_now) && $rf_playing_now === $fpp_sequence) {
            if (!empty($rf_data['playingNext']) || count($requests) > 0) {
                return true;
            }
        }

        // Conservative default
        return false;
    }

    /**
     * Check if a specific song can play before reset
     */
    public static function can_song_play($song_duration, $current_wait, $time_until_reset) {
        if ($time_until_reset === null) {
            return ['allowed' => true, 'reason' => null];
        }

        // Hard lockout
        if ($time_until_reset < self::$lockout_seconds) {
            return [
                'allowed' => false,
                'reason'  => 'time_lockout',
            ];
        }

        // Calculate if song will finish in time (with 60s buffer)
        $total_time = $current_wait + $song_duration + 60;
        
        if ($total_time > $time_until_reset) {
            return [
                'allowed' => false,
                'reason'  => 'queue_lockout',
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
