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

        return [
            'holiday_mode' => $holiday_mode,
            'features'     => $features,
            'copy'         => $copy,
            'showtimes'    => $showtimes,
            'speaker'      => $speakerConfig,
        ];
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