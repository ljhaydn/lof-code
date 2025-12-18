<?php

if (!defined('ABSPATH')) {
    exit;
}

class LOF_API {

    public static function init() {
        add_action('rest_api_init', function () {

            register_rest_route('lof-extras/v1', '/viewer-config', [
                'methods'             => 'GET',
                'callback'            => [__CLASS__, 'viewer_config'],
                'permission_callback' => '__return_true',
            ]);

            register_rest_route('lof-extras/v1', '/glow', [
                'methods'             => 'POST',
                'callback'            => [__CLASS__, 'handle_glow'],
                'permission_callback' => '__return_true',
            ]);

            register_rest_route('lof-extras/v1', '/speaker-press', [
                'methods'             => 'POST',
                'callback'            => [__CLASS__, 'handle_speaker_press'],
                'permission_callback' => '__return_true',
            ]);

            register_rest_route('lof-extras/v1', '/fpp/status', [
                'methods'             => 'GET',
                'callback'            => [__CLASS__, 'fpp_status'],
                'permission_callback' => '__return_true',
            ]);
        });
    }

    /**
     * Viewer config endpoint
     *
     * Returns:
     * - holiday_mode
     * - features (surprise/glow/speaker/fog toggles)
     * - copy (all text keys, merged defaults + overrides)
     * - showtimes (parsed windows)
     * - speaker (timing / cooldown config)
     */
    public static function viewer_config(\WP_REST_Request $request) {
        $settings = get_option(LOF_Settings::OPTION_NAME, []);

        $holiday_mode = isset($settings['holiday_mode']) && $settings['holiday_mode'] !== ''
            ? $settings['holiday_mode']
            : 'offseason';

        $features = [
            'surprise_me' => !empty($settings['enable_surprise_me']),
            'glow'        => !empty($settings['enable_glow']),
            'speaker'     => !empty($settings['enable_speaker']),
            'fog'         => !empty($settings['enable_fog']),
        ];

        $showtimes = self::parse_showtimes(isset($settings['showtimes_json']) ? $settings['showtimes_json'] : '');

        // Merge defaults + settings into a single copy map
        $copy_defaults = self::default_copy();
        $copy          = [];

        foreach ($copy_defaults as $key => $default) {
            if (isset($settings[$key]) && $settings[$key] !== '') {
                $copy[$key] = $settings[$key];
            } else {
                $copy[$key] = $default;
            }
        }

        $speakerConfig = [
            'minutes_default' => isset($settings['speaker_minutes_default']) && is_numeric($settings['speaker_minutes_default'])
                ? (int) $settings['speaker_minutes_default']
                : 5,
            'max_extension'   => isset($settings['speaker_max_extension']) && is_numeric($settings['speaker_max_extension'])
                ? (int) $settings['speaker_max_extension']
                : 180,
            'cooldown'        => isset($settings['speaker_cooldown']) && is_numeric($settings['speaker_cooldown'])
                ? (int) $settings['speaker_cooldown']
                : 15,
        ];

        // V1.5: Geo + Cloudflare metadata for the viewer page.
        // For the 2025 season we always enable the geo card and derive visitor
        // location from Cloudflare headers when available.
        $geo_enabled = true;

        $cloudflare = [
            'city'    => isset($_SERVER['HTTP_CF_IPCITY']) ? sanitize_text_field(wp_unslash($_SERVER['HTTP_CF_IPCITY'])) : '',
            'region'  => isset($_SERVER['HTTP_CF_REGION']) ? sanitize_text_field(wp_unslash($_SERVER['HTTP_CF_REGION'])) : '',
            'country' => isset($_SERVER['HTTP_CF_IPCOUNTRY']) ? sanitize_text_field(wp_unslash($_SERVER['HTTP_CF_IPCOUNTRY'])) : '',
        ];

        if (isset($_SERVER['HTTP_CF_IPLATITUDE']) && isset($_SERVER['HTTP_CF_IPLONGITUDE'])) {
            $cloudflare['latitude']  = (float) $_SERVER['HTTP_CF_IPLATITUDE'];
            $cloudflare['longitude'] = (float) $_SERVER['HTTP_CF_IPLONGITUDE'];
        }

        // Approximate show location – used only for viewer geo copy and distance
        // calculations. If the display ever moves, this is the single place to update.
        $show_lat  = 33.8334;
        $show_long = -118.17243;

        return [
            'holiday_mode'    => $holiday_mode,
            'features'        => $features,
            'copy'            => $copy,
            'showtimes'       => $showtimes,
            'speaker'         => $speakerConfig,
            // V1.5 geo + Cloudflare data for rf-viewer.js
            'geoCheckEnabled' => false, // emergency disabled,
            // V1.5.2: Geo kill switch - set to true to bypass all geo checks during showtime issues
            'geoForceBypass'  => false,
            'showLatitude'    => $show_lat,
            'showLongitude'   => $show_long,
            'cloudflare'      => $cloudflare,
        ];
    }

    /**
     * FPP status proxy for Viewer 1.5.
     *
     * This delegates to the existing /lof-viewer/v1/fpp/status endpoint so that
     * rf-viewer.js can call a stable lof-extras namespace without changing the
     * underlying implementation during the 2025 season.
     *
     * TODO (post-season): Replace this proxy with a direct, minimal FPP integration
     * that is independent of the Viewer v2 implementation.
     */
    public static function fpp_status(\WP_REST_Request $request) {
        // Mini FPP status endpoint for Viewer 1.5.
        // This calls FPP directly and returns a minimal, stable shape
        // so that rf-viewer.js is not coupled to the Viewer v2 implementation.

        // Pull FPP base URL from settings, with a couple of reasonable fallbacks.
        $settings = get_option(LOF_Settings::OPTION_NAME, []);
        $base     = '';

        if (isset($settings['fpp_base_url']) && $settings['fpp_base_url'] !== '') {
            $base = $settings['fpp_base_url'];
        } elseif (isset($settings['fpp_host']) && $settings['fpp_host'] !== '') {
            $base = $settings['fpp_host'];
        } else {
            // Legacy option key used in some earlier integrations.
            $legacy = get_option('lof_viewer_fpp_base', '');
            if (!empty($legacy)) {
                $base = $legacy;
            }
        }

        if (!$base) {
            return new \WP_REST_Response([
                'success' => false,
                'error'   => 'fpp_base_missing',
                'message' => 'FPP base URL is not configured.',
            ], 500);
        }

        $base = rtrim($base, '/');
        $url  = $base . '/api/fppd/status';

        $response = wp_remote_get($url, [
            'timeout' => 3,
        ]);

        if (is_wp_error($response)) {
            return new \WP_REST_Response([
                'success' => false,
                'error'   => 'fpp_request_failed',
                'message' => $response->get_error_message(),
            ], 502);
        }

        $code = wp_remote_retrieve_response_code($response);
        $body = wp_remote_retrieve_body($response);

        if ($code < 200 || $code >= 300) {
            return new \WP_REST_Response([
                'success' => false,
                'error'   => 'fpp_bad_status',
                'message' => 'FPP returned HTTP ' . $code,
            ], 502);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            return new \WP_REST_Response([
                'success' => false,
                'error'   => 'fpp_invalid_json',
                'message' => 'Could not decode FPP status JSON.',
            ], 502);
        }

        // Shape a minimal, stable payload for the viewer.
        $statusName       = isset($decoded['status_name']) ? (string) $decoded['status_name'] : '';
        $secondsRemaining = isset($decoded['seconds_remaining']) ? (int) $decoded['seconds_remaining'] : 0;
        $secondsPlayed    = isset($decoded['seconds_played']) ? (int) $decoded['seconds_played'] : 0;

        // If scheduler.currentPlaylist exists, prefer its playlistName & secondsRemaining
        $playlistName = '';
        if (isset($decoded['scheduler']['currentPlaylist']['playlistName'])) {
            $playlistName = (string) $decoded['scheduler']['currentPlaylist']['playlistName'];
        }
        if (isset($decoded['scheduler']['currentPlaylist']['secondsRemaining'])) {
            $secondsRemaining = (int) $decoded['scheduler']['currentPlaylist']['secondsRemaining'];
        }

        $payload = [
            'success'           => true,
            'status_name'       => $statusName,
            'seconds_remaining' => $secondsRemaining,
            'seconds_played'    => $secondsPlayed,
            'playlist_name'     => $playlistName,
            'raw'               => $decoded,
        ];

        return new \WP_REST_Response($payload, 200);
    }

    protected static function parse_showtimes($json) {
        if (!$json) {
            return [
                ['start' => '17:00', 'end' => '21:00'],
            ];
        }

        $decoded = json_decode($json, true);
        if (!is_array($decoded)) {
            return [
                ['start' => '17:00', 'end' => '21:00'],
            ];
        }

        $clean = [];
        foreach ($decoded as $win) {
            if (!is_array($win)) {
                continue;
            }
            $start = isset($win['start']) ? $win['start'] : null;
            $end   = isset($win['end'])   ? $win['end']   : null;
            if (!$start || !$end) {
                continue;
            }
            $clean[] = [
                'start' => $start,
                'end'   => $end,
            ];
        }

        if (!$clean) {
            $clean[] = ['start' => '17:00', 'end' => '21:00'];
        }

        return $clean;
    }

    /**
     * All viewer copy defaults live here.
     * Anything added here can be overridden in LOF_Settings and will
     * automatically appear in the REST viewer-config under copy[key].
     */
    protected static function default_copy() {
        return [
            // Banner
            'banner_showtime_title'      => 'Showtime 🎶',
            'banner_showtime_sub'        => 'Lights, audio, and neighbors in sync.',
            'banner_intermission_title'  => 'Intermission',
            'banner_intermission_sub'    => 'The lights are catching their breath between songs.',
            'banner_afterhours_title'    => 'We’re taking a breather',
            'banner_afterhours_sub'      => 'The lights are resting for now.',
            'banner_offseason_title'     => 'We’re resting up for next season',
            'banner_offseason_sub'       => 'Check back soon for more glowing chaos.',

            // Header (viewer hero)
            'header_jukebox_title'      => 'Tap a song to request it 🎧',
            'header_jukebox_intro'      => 'Requests join the queue in the order they come in.',
            'header_jukebox_queue'      => 'There are currently {queueCount} songs in the queue.',
            'header_jukebox_limit'      => 'You can request up to {requestLimit} songs per session.',
            'header_jukebox_geo'        => 'Viewer control may be limited to guests near the show location.',
            'header_jukebox_late'       => 'Late-night Falcon fans are the real MVPs. 🌙',

            'header_voting_title'       => 'Vote for your favorites 🗳️',
            'header_voting_intro'       => 'Songs with the most votes rise to the top. Tap a track below to help decide what plays next.',
            'header_voting_late'        => 'Bonus points for after-dark voting energy. 🌒',

            'header_paused_title'       => 'Viewer control is currently paused',
            'header_paused_body'        => 'You can still enjoy the show — we’ll turn song requests and voting back on soon.',

            'header_default_title'      => 'Interactive show controls',
            'header_default_body'       => 'Use the controls below to interact with the Lights on Falcon show in real time.',

            // Speaker
            'speaker_btn_on'             => 'Turn speakers on 🔊',
            'speaker_btn_off'            => 'Turn speakers off',
            'speaker_status_on'          => 'Speakers are currently ON near the show.',
            'speaker_status_off'         => 'Speakers are currently OFF. If you’re standing at the show, you can turn them on.',
            'speaker_status_unknown'     => 'Unable to read speaker status.',
            'speaker_time_left_prefix'   => 'Time left:',
            'speaker_error_msg'          => 'Something glitched while talking to the speakers.',

            // Glow
            'glow_title'                 => 'Send a little glow 💚',
            'glow_sub'                   => 'Drop a short note of thanks, joy, or encouragement.',
            'glow_placeholder'           => 'Tell us who made your night, or what made you smile…',
            'glow_name_placeholder'      => 'Name or initials (optional)',
            'glow_btn'                   => 'Send this glow ✨',
            'glow_success_toast'         => 'Glow sent. Thanks for sharing the love. 💚',
            'glow_error_toast'           => 'Could not send glow. Please try again.',
            'glow_too_short'             => 'Give us a little more than that. 🙂',
            'glow_too_long'              => 'That\'s a bit too long for a quick glow.',
            'glow_rate_limited'          => 'You just sent a glow. Give it a minute before sending another.',

            // Surprise Me
            'surprise_title'             => 'Can’t pick just one?',
            'surprise_sub'               => 'Let us queue up a random crowd-pleaser for you.',
            'surprise_btn'               => 'Surprise me ✨',
            'surprise_success'           => 'Request sent! You’re in the queue.',
            'surprise_fourth_time'       => 'You like chaos. We respect that. 😈',
            'surprise_disabled'          => 'Viewer control is currently paused.',

            // Stats
            'stats_title'                => 'Tonight from this device',
            'stats_requests_label'       => 'Requests sent',
            'stats_surprise_label'       => '“Surprise me” taps',
            'stats_vibe_label'           => 'Falcon vibe check',
            'stats_vibe_low'             => 'Cozy & chill 😌',
            'stats_vibe_med'             => 'Party forming 🕺',
            'stats_vibe_high'            => 'Full-send Falcon 🔥',
        ];
    }

    /**
     * Handle “glow” submissions.
     * For now: log to a file or post type. This can evolve later.
     */
    public static function handle_glow(\WP_REST_Request $request) {
        $params = $request->get_json_params();

        $message = isset($params['message']) ? trim(wp_kses_post($params['message'])) : '';
        $name    = isset($params['name']) ? trim(sanitize_text_field($params['name'])) : '';

        if (mb_strlen($message) < 5) {
            return new \WP_REST_Response([
                'success' => false,
                'error'   => 'too_short',
                'message' => 'Glow is too short.',
            ], 400);
        }
        if (mb_strlen($message) > 500) {
            return new \WP_REST_Response([
                'success' => false,
                'error'   => 'too_long',
                'message' => 'Glow is too long.',
            ], 400);
        }

        $log_line = sprintf(
            "[%s] %s | %s\n",
            gmdate('c'),
            $message,
            $name ?: 'anonymous'
        );

        $upload_dir = wp_upload_dir();
        $dir        = trailingslashit($upload_dir['basedir']) . 'lof-glows';
        if (!file_exists($dir)) {
            wp_mkdir_p($dir);
        }
        $file = trailingslashit($dir) . 'glows.log';
        file_put_contents($file, $log_line, FILE_APPEND | LOCK_EX);

        return [
            'success' => true,
        ];
    }

    /**
     * Handle a "speaker button press" notification from FPP.
     * For now this can be extended later for analytics.
     */
    public static function handle_speaker_press(\WP_REST_Request $request) {
        // Placeholder for now – we just acknowledge it.
        return [
            'success' => true,
        ];
    }
}