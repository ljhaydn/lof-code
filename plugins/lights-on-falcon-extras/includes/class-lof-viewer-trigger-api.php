<?php
/**
 * LOF Viewer Trigger API
 * 
 * REST endpoints for trigger counts, surprise-me with personality,
 * song leaderboards, and vibe check data.
 * 
 * @package Lights_On_Falcon
 * @since 1.5.0
 */

if (!defined('ABSPATH')) {
    exit;
}

// Include MongoDB class if available
$mongo_class = dirname(__FILE__) . '/class-lof-mongo.php';
if (file_exists($mongo_class)) {
    require_once $mongo_class;
}

add_action('rest_api_init', function () {
    register_rest_route(
        'lof-viewer/v1',
        '/trigger-hit',
        array(
            'methods'             => 'POST',
            'callback'            => 'lof_viewer_trigger_hit',
            'permission_callback' => '__return_true',
        )
    );

    register_rest_route(
        'lof-viewer/v1',
        '/trigger-counts',
        array(
            'methods'             => 'GET',
            'callback'            => 'lof_viewer_get_trigger_counts',
            'permission_callback' => '__return_true',
        )
    );

    register_rest_route(
        'lof-viewer/v1',
        '/surprise-me',
        array(
            'methods'             => array('GET', 'POST'),
            'callback'            => 'lof_viewer_surprise_me',
            'permission_callback' => '__return_true',
        )
    );

    // V1.5: New endpoints for leaderboard and vibe
    register_rest_route(
        'lof-viewer/v1',
        '/leaderboard',
        array(
            'methods'             => 'GET',
            'callback'            => 'lof_viewer_get_leaderboard',
            'permission_callback' => '__return_true',
        )
    );

    register_rest_route(
        'lof-viewer/v1',
        '/vibe-check',
        array(
            'methods'             => 'GET',
            'callback'            => 'lof_viewer_get_vibe',
            'permission_callback' => '__return_true',
        )
    );

    register_rest_route(
        'lof-viewer/v1',
        '/song-badges',
        array(
            'methods'             => 'GET',
            'callback'            => 'lof_viewer_get_song_badges',
            'permission_callback' => '__return_true',
        )
    );
});

/**
 * POST /wp-json/lof-viewer/v1/trigger-hit
 */
function lof_viewer_trigger_hit(WP_REST_Request $request) {
    $shared_secret = 'santasmailbox';

    $header_token = $request->get_header('x-lof-trigger-token');
    if ($header_token !== $shared_secret) {
        return new WP_REST_Response(array('error' => 'unauthorized'), 403);
    }

    $body = json_decode($request->get_body(), true);
    if (!is_array($body)) {
        return new WP_REST_Response(array('error' => 'invalid_json'), 400);
    }

    $trigger_key = isset($body['trigger_key']) ? sanitize_key($body['trigger_key']) : '';
    $total       = isset($body['total']) ? intval($body['total']) : null;
    $source      = isset($body['source']) ? sanitize_key($body['source']) : 'unknown';

    if (!$trigger_key) {
        return new WP_REST_Response(array('error' => 'missing trigger_key'), 400);
    }

    $counts = get_option('lof_viewer_trigger_counts', array());
    if (!is_array($counts)) {
        $counts = array();
    }

    if (null !== $total) {
        $counts[$trigger_key] = $total;
    } else {
        if (!isset($counts[$trigger_key])) {
            $counts[$trigger_key] = 0;
        }
        $counts[$trigger_key]++;
    }

    // V1.5: Track source breakdown (physical button vs website)
    $source_key = $trigger_key . '_' . $source;
    if (!isset($counts[$source_key])) {
        $counts[$source_key] = 0;
    }
    $counts[$source_key]++;

    update_option('lof_viewer_trigger_counts', $counts);

    return new WP_REST_Response(
        array(
            'success'     => true,
            'trigger_key' => $trigger_key,
            'count'       => $counts[$trigger_key],
            'source'      => $source,
        ),
        200
    );
}

/**
 * GET /wp-json/lof-viewer/v1/trigger-counts
 * 
 * Enhanced with MongoDB data for accurate stats and leaderboard.
 */
function lof_viewer_get_trigger_counts(WP_REST_Request $request) {
    $counts = get_option('lof_viewer_trigger_counts', array());
    if (!is_array($counts)) {
        $counts = array();
    }

    // Merge glow count
    $glow_stats = get_option('lof_viewer_extras_glow_stats', array('total' => 0));
    if (is_array($glow_stats) && isset($glow_stats['total'])) {
        $counts['glow'] = (int) $glow_stats['total'];
    }

    // Merge speaker count
    $speaker_count = get_option('lof_speaker_press_count', 0);
    if ($speaker_count > 0) {
        $counts['speaker'] = (int) $speaker_count;
    }

    // Merge surprise count
    $surprise_count = get_option('lof_viewer_surprise_count', 0);
    if ($surprise_count > 0) {
        $counts['surprise'] = (int) $surprise_count;
    }

    // V1.5: Get MongoDB stats if available
    $mongo_available = class_exists('LOF_Mongo');
    
    if ($mongo_available) {
        try {
            // Real request counts from RF database
            $counts['requests_tonight'] = LOF_Mongo::get_requests_tonight();
            $counts['requests_season'] = LOF_Mongo::get_requests_season();
            
            // Top songs
            $top_tonight = LOF_Mongo::get_top_songs_tonight(3);
            $top_season = LOF_Mongo::get_top_songs_season(1);
            
            if (!empty($top_tonight)) {
                $counts['popular_tonight'] = $top_tonight[0]['displayName'];
                $counts['popular_tonight_count'] = $top_tonight[0]['count'];
            }
            
            if (!empty($top_season)) {
                $counts['popular_alltime'] = $top_season[0]['displayName'];
                $counts['popular_alltime_count'] = $top_season[0]['count'];
            }
            
            // Requests per hour for vibe
            $counts['requests_per_hour'] = LOF_Mongo::get_requests_per_hour_tonight();
            
        } catch (Exception $e) {
            error_log('[LOF Trigger API] MongoDB query failed: ' . $e->getMessage());
        }
    }

    // V1.5: Apply FOMO padding to season stats
    $padding = array(
        'requests_season' => 800,
        'glow'            => 300,
        'surprise'        => 100,
        'speaker'         => 200,
        'mailbox'         => 50,
    );

    $display_counts = array();
    foreach ($counts as $key => $value) {
        if (isset($padding[$key])) {
            $display_counts[$key] = (int) $value + $padding[$key];
        } else {
            $display_counts[$key] = $value;
        }
    }

    // Also include raw counts for internal use
    $display_counts['_raw'] = $counts;

    return new WP_REST_Response(
        array(
            'success' => true,
            'counts'  => $display_counts,
            'mongo'   => $mongo_available,
        ),
        200
    );
}

/**
 * GET /wp-json/lof-viewer/v1/leaderboard
 * 
 * Returns song leaderboards for tonight and season.
 */
function lof_viewer_get_leaderboard(WP_REST_Request $request) {
    if (!class_exists('LOF_Mongo')) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'MongoDB not available',
            ),
            503
        );
    }

    try {
        $top_tonight = LOF_Mongo::get_top_songs_tonight(5);
        $top_season = LOF_Mongo::get_top_songs_season(5);

        return new WP_REST_Response(
            array(
                'success' => true,
                'tonight' => $top_tonight,
                'season'  => $top_season,
            ),
            200
        );
    } catch (Exception $e) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => $e->getMessage(),
            ),
            500
        );
    }
}

/**
 * GET /wp-json/lof-viewer/v1/vibe-check
 * 
 * Returns vibe level based on global activity.
 */
function lof_viewer_get_vibe(WP_REST_Request $request) {
    $timezone = new DateTimeZone('America/Los_Angeles');
    $now = new DateTime('now', $timezone);
    $hour = (int) $now->format('G');

    // Default activity score
    $activity_score = 0;
    $requests_per_hour = 0;

    // Get real data from MongoDB if available
    if (class_exists('LOF_Mongo')) {
        try {
            $requests_per_hour = LOF_Mongo::get_requests_per_hour_tonight();
            $requests_tonight = LOF_Mongo::get_requests_tonight();
            
            // Base score from recent activity
            $activity_score = $requests_per_hour;
            
            // Boost for overall night activity
            if ($requests_tonight > 30) {
                $activity_score += 5;
            } elseif ($requests_tonight > 15) {
                $activity_score += 2;
            }
        } catch (Exception $e) {
            error_log('[LOF Vibe] MongoDB query failed: ' . $e->getMessage());
        }
    }

    // Fallback: use trigger counts
    $counts = get_option('lof_viewer_trigger_counts', array());
    $glow_count = get_option('lof_viewer_extras_glow_stats', array('total' => 0));
    $glow = isset($glow_count['total']) ? (int) $glow_count['total'] : 0;
    
    // Add glow and speaker activity to score
    $activity_score += ($glow * 0.3);

    // Time-based boost: later evening = more energy expected
    $time_boost = 0;
    if ($hour >= 20) {
        $time_boost = 3;
    } elseif ($hour >= 18) {
        $time_boost = 1;
    }
    $activity_score += $time_boost;

    // Determine vibe level with time-based minimums
    $vibe = array(
        'level' => 'setup',
        'emoji' => '🔧',
        'text'  => 'Elves running system checks...',
        'score' => $activity_score,
    );

    // Before 5pm: Setup mode with fun personality
    if ($hour < 17) {
        $setup_messages = array(
            array('emoji' => '🔧', 'text' => 'Elves running system checks...'),
            array('emoji' => '⚡', 'text' => 'Zip ties holding... barely'),
            array('emoji' => '🎅', 'text' => 'Santa reviewing the setlist'),
            array('emoji' => '🔌', 'text' => 'Who unplugged the extension cord?'),
            array('emoji' => '☕', 'text' => 'Fueling up on cocoa'),
        );
        $pick = $setup_messages[array_rand($setup_messages)];
        $vibe['level'] = 'setup';
        $vibe['emoji'] = $pick['emoji'];
        $vibe['text'] = $pick['text'];
    }
    // 5pm-6pm: Warming up (minimum floor)
    elseif ($hour >= 17 && $hour < 18) {
        if ($activity_score >= 20) {
            $vibe = array('level' => 'lit', 'emoji' => '🔥', 'text' => "Neighborhood's buzzing!", 'score' => $activity_score);
        } elseif ($activity_score >= 10) {
            $vibe = array('level' => 'forming', 'emoji' => '🎄', 'text' => "Crowd's arriving!", 'score' => $activity_score);
        } else {
            // Minimum during 5-6pm
            $warming_messages = array(
                array('emoji' => '✨', 'text' => 'Early birds catch the glow'),
                array('emoji' => '🌟', 'text' => 'Magic brewing...'),
                array('emoji' => '🎄', 'text' => 'The first guests arrive'),
            );
            $pick = $warming_messages[array_rand($warming_messages)];
            $vibe = array('level' => 'warming', 'emoji' => $pick['emoji'], 'text' => $pick['text'], 'score' => $activity_score);
        }
    }
    // 6pm-11pm: Show time (minimum "Party forming")
    elseif ($hour >= 18 && $hour < 23) {
        if ($activity_score >= 30) {
            $vibe = array('level' => 'legendary', 'emoji' => '🏆', 'text' => 'THIS IS LEGENDARY', 'score' => $activity_score);
        } elseif ($activity_score >= 20) {
            $vibe = array('level' => 'fullsend', 'emoji' => '⚡', 'text' => 'FULL SEND FALCON', 'score' => $activity_score);
        } elseif ($activity_score >= 12) {
            $vibe = array('level' => 'lit', 'emoji' => '🔥', 'text' => "Neighborhood's LIT!", 'score' => $activity_score);
        } else {
            // Minimum during show hours - never lower than "Party forming"
            $vibe = array('level' => 'forming', 'emoji' => '🎄', 'text' => "Crowd's arriving!", 'score' => $activity_score);
        }
    }
    // After 11pm: Winding down
    else {
        if ($activity_score >= 15) {
            $vibe = array('level' => 'lit', 'emoji' => '🔥', 'text' => 'Late night legends!', 'score' => $activity_score);
        } elseif ($activity_score >= 5) {
            $vibe = array('level' => 'cozy', 'emoji' => '🌙', 'text' => 'Cozy night owls', 'score' => $activity_score);
        } else {
            $vibe = array('level' => 'resting', 'emoji' => '💤', 'text' => 'The lights are dreaming', 'score' => $activity_score);
        }
    }

    $vibe['hour'] = $hour;
    $vibe['requests_per_hour'] = $requests_per_hour;

    return new WP_REST_Response(
        array(
            'success' => true,
            'vibe'    => $vibe,
        ),
        200
    );
}

/**
 * GET /wp-json/lof-viewer/v1/song-badges
 * 
 * Returns badge data for all songs.
 */
function lof_viewer_get_song_badges(WP_REST_Request $request) {
    if (!class_exists('LOF_Mongo')) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'badges'  => array(),
            ),
            200
        );
    }

    try {
        $sequences = LOF_Mongo::get_sequences_with_stats();

        return new WP_REST_Response(
            array(
                'success' => true,
                'badges'  => $sequences,
            ),
            200
        );
    } catch (Exception $e) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => $e->getMessage(),
            ),
            500
        );
    }
}

/**
 * GET/POST /wp-json/lof-viewer/v1/surprise-me
 * 
 * Enhanced with personality-driven selection and fun feedback.
 */
function lof_viewer_surprise_me(WP_REST_Request $request) {
    // 1) Fetch current show details
    $show_url = rest_url('rf/v1/showDetails');

    $show_resp = wp_remote_get(
        $show_url,
        array(
            'timeout' => 10,
            'headers' => array('Accept' => 'application/json'),
        )
    );

    if (is_wp_error($show_resp)) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'Unable to reach show details proxy.',
            ),
            500
        );
    }

    $show_code = wp_remote_retrieve_response_code($show_resp);
    $show_body = wp_remote_retrieve_body($show_resp);
    $show_json = json_decode($show_body, true);

    if (200 !== $show_code || !is_array($show_json)) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'Unexpected response from show details proxy.',
            ),
            500
        );
    }

    $core = (isset($show_json['data']) && is_array($show_json['data']))
        ? $show_json['data']
        : $show_json;

    $sequences = array();
    if (isset($core['sequences']) && is_array($core['sequences'])) {
        $sequences = $core['sequences'];
    }

    if (empty($sequences)) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'No sequences available for Surprise Me.',
            ),
            500
        );
    }

    $playing_now_raw  = isset($core['playingNow']) ? (string) $core['playingNow'] : '';
    $playing_next_raw = isset($core['playingNext']) ? (string) $core['playingNext'] : '';

    // 2) Build candidate pools with categories
    $candidates = array();
    $hidden_gems = array();
    $crowd_favorites = array();
    $fresh_picks = array();

    // Get badge data for categorization
    $badges_data = array();
    if (class_exists('LOF_Mongo')) {
        try {
            $badges_data = LOF_Mongo::get_sequences_with_stats();
        } catch (Exception $e) {
            // Continue without badges
        }
    }

    foreach ($sequences as $seq) {
        if (!is_array($seq)) {
            continue;
        }

        $name         = isset($seq['name']) ? (string) $seq['name'] : '';
        $display_name = isset($seq['displayName']) ? (string) $seq['displayName'] : '';

        if ('' === $name && '' === $display_name) {
            continue;
        }

        if (isset($seq['visible']) && !$seq['visible']) {
            continue;
        }
        if (isset($seq['active']) && !$seq['active']) {
            continue;
        }

        // Skip currently playing
        if ($playing_now_raw && ($name === $playing_now_raw || $display_name === $playing_now_raw)) {
            continue;
        }
        if ($playing_next_raw && ($name === $playing_next_raw || $display_name === $playing_next_raw)) {
            continue;
        }

        $candidates[] = $seq;

        // Categorize for personality picks
        if (isset($badges_data[$name])) {
            $song_badges = $badges_data[$name]['badges'] ?? array();
            foreach ($song_badges as $badge) {
                if ($badge['type'] === 'gem') {
                    $hidden_gems[] = $seq;
                } elseif ($badge['type'] === 'favorite' || $badge['type'] === 'hot') {
                    $crowd_favorites[] = $seq;
                }
            }
            // Low season count = underplayed
            if (($badges_data[$name]['season_count'] ?? 0) < 5) {
                $fresh_picks[] = $seq;
            }
        } else {
            // No badge data = hidden gem
            $hidden_gems[] = $seq;
        }
    }

    if (empty($candidates)) {
        $candidates = $sequences;
    }

    // 3) Avoid recent picks
    $recent_key   = 'lof_viewer_surprise_recent';
    $recent_names = get_transient($recent_key);
    if (!is_array($recent_names)) {
        $recent_names = array();
    }

    $pool = array();
    foreach ($candidates as $seq) {
        $name = isset($seq['name']) ? (string) $seq['name'] : '';
        if ('' !== $name && !in_array($name, $recent_names, true)) {
            $pool[] = $seq;
        }
    }

    if (empty($pool)) {
        $pool = $candidates;
    }

    // 4) Weighted random pick with personality
    // 30% chance: crowd favorite, 25% chance: hidden gem, 20% chance: fresh, 25% chance: pure random
    $pick_type = 'random';
    $roll = mt_rand(1, 100);

    $chosen = null;

    if ($roll <= 30 && !empty($crowd_favorites)) {
        // Pick from crowd favorites
        $filtered = array_filter($crowd_favorites, function($s) use ($recent_names) {
            return !in_array($s['name'] ?? '', $recent_names, true);
        });
        if (!empty($filtered)) {
            $chosen = $filtered[array_rand($filtered)];
            $pick_type = 'favorite';
        }
    } elseif ($roll <= 55 && !empty($hidden_gems)) {
        // Pick a hidden gem
        $filtered = array_filter($hidden_gems, function($s) use ($recent_names) {
            return !in_array($s['name'] ?? '', $recent_names, true);
        });
        if (!empty($filtered)) {
            $chosen = $filtered[array_rand($filtered)];
            $pick_type = 'gem';
        }
    } elseif ($roll <= 75 && !empty($fresh_picks)) {
        // Pick something underplayed
        $filtered = array_filter($fresh_picks, function($s) use ($recent_names) {
            return !in_array($s['name'] ?? '', $recent_names, true);
        });
        if (!empty($filtered)) {
            $chosen = $filtered[array_rand($filtered)];
            $pick_type = 'fresh';
        }
    }

    // Fallback to pure random
    if (!$chosen && !empty($pool)) {
        $chosen = $pool[array_rand($pool)];
        $pick_type = 'chaos';
    }

    if (!$chosen) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'No eligible sequences found.',
            ),
            500
        );
    }

    $chosen_name  = isset($chosen['name']) ? (string) $chosen['name'] : '';
    $chosen_label = isset($chosen['displayName']) ? (string) $chosen['displayName'] : $chosen_name;

    // Update recent picks
    array_unshift($recent_names, $chosen_name);
    $recent_names = array_values(array_unique($recent_names));
    $recent_names = array_slice($recent_names, 0, 5);
    set_transient($recent_key, $recent_names, 12 * HOUR_IN_SECONDS);

    // 5) Queue the request
    $request_url = rest_url('rf/v1/request');
    $body        = array('sequence' => $chosen_name);

    $rf_resp = wp_remote_post(
        $request_url,
        array(
            'timeout' => 10,
            'headers' => array(
                'Content-Type' => 'application/json',
                'Accept'       => 'application/json',
            ),
            'body'    => wp_json_encode($body),
        )
    );

    if (is_wp_error($rf_resp)) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'Unable to queue Surprise Me request.',
            ),
            500
        );
    }

    $rf_code = wp_remote_retrieve_response_code($rf_resp);
    $rf_json = json_decode(wp_remote_retrieve_body($rf_resp), true);

    if ($rf_code < 200 || $rf_code >= 300) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'Remote Falcon did not accept the request.',
                'rf'      => array('status' => $rf_code),
            ),
            500
        );
    }

    // Increment surprise counter
    $surprise_count = (int) get_option('lof_viewer_surprise_count', 0);
    update_option('lof_viewer_surprise_count', $surprise_count + 1);

    // 6) Generate personality message
    $personality_messages = array(
        'favorite' => array(
            '🏆 Going with a crowd favorite!',
            '👑 The people have spoken!',
            '🔥 Hot pick incoming!',
        ),
        'gem' => array(
            '💎 Unearthing a hidden gem!',
            '✨ Found something special!',
            '🎁 Unwrapping a surprise!',
        ),
        'fresh' => array(
            '🌟 Something different!',
            '🎲 Mixing it up!',
            '⚡ Fresh energy incoming!',
        ),
        'chaos' => array(
            '🎲 Full chaos mode!',
            '✨ DJ Falcon\'s choice!',
            '🎉 Let\'s see what happens!',
        ),
    );

    $messages = $personality_messages[$pick_type] ?? $personality_messages['chaos'];
    $toast_message = $messages[array_rand($messages)];

    return new WP_REST_Response(
        array(
            'success'  => true,
            'message'  => $toast_message,
            'sequence' => array(
                'name'        => $chosen_name,
                'displayName' => $chosen_label,
            ),
            'pick_type' => $pick_type,
            'rf'        => array(
                'status' => $rf_code,
            ),
        ),
        200
    );
}
