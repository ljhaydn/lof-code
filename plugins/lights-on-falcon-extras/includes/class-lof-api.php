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

            register_rest_route('lof-extras/v1', '/neighbor', [
                'methods'             => 'POST',
                'callback'            => [__CLASS__, 'handle_neighbor'],
                'permission_callback' => '__return_true',
            ]);

            register_rest_route('lof-extras/v1', '/presence/ping', [
                'methods'             => 'POST',
                'callback'            => [__CLASS__, 'presence_ping'],
                'permission_callback' => '__return_true',
            ]);

            register_rest_route('lof-extras/v1', '/presence/summary', [
                'methods'             => 'GET',
                'callback'            => [__CLASS__, 'presence_summary'],
                'permission_callback' => '__return_true',
            ]);

        });
    }

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
            'showtimes'    => $showtimes,
            'copy'         => $copy,
            'speaker'      => $speakerConfig,
        ];
    }

    protected static function parse_showtimes($json) {
        if (empty($json)) {
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
            $end   = isset($win['end']) ? $win['end'] : null;
            if ($start && $end) {
                $clean[] = [
                    'start' => $start,
                    'end'   => $end,
                ];
            }
        }

        if (!$clean) {
            $clean[] = ['start' => '17:00', 'end' => '21:00'];
        }

        return $clean;
    }

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
            'glow_target_placeholder'    => 'Who is this for? (optional)',
            'glow_submit_label'          => 'Send glow',
            'glow_success_toast'         => 'Glow sent. Thanks for sharing the love. 💚',
            'glow_error_toast'           => 'Could not send glow. Please try again.',
            'glow_disabled_text'         => 'Glow sending is currently paused.',

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
     * Ensure our custom LOF tables exist. This can safely be called at runtime.
     */
    protected static function ensure_tables() {
        global $wpdb;
        $prefix = $wpdb->prefix;

        $glow_table     = $prefix . 'lof_glows';
        $neighbor_table = $prefix . 'lof_neighbor_nominations';
        $presence_table = $prefix . 'lof_presence_sessions';

        // Simple existence check on one table; if it's missing, (re)run all CREATEs.
        $existing = $wpdb->get_var(
            $wpdb->prepare(
                'SHOW TABLES LIKE %s',
                $glow_table
            )
        );

        if ($existing !== $glow_table) {
            self::create_tables();
        }
    }

    /**
     * Create / update LOF tables using dbDelta.
     */
    protected static function create_tables() {
        global $wpdb;

        require_once ABSPATH . 'wp-admin/includes/upgrade.php';

        $charset_collate = $wpdb->get_charset_collate();
        $glow_table      = $wpdb->prefix . 'lof_glows';
        $neighbor_table  = $wpdb->prefix . 'lof_neighbor_nominations';
        $presence_table  = $wpdb->prefix . 'lof_presence_sessions';

        $sql_glows = "
            CREATE TABLE {$glow_table} (
                id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                created_at      DATETIME        NOT NULL,
                ip_hash         CHAR(64)        NULL,
                user_agent      VARCHAR(255)    NULL,
                from_name       VARCHAR(100)    NULL,
                to_name         VARCHAR(100)    NULL,
                relationship    VARCHAR(100)    NULL,
                message         TEXT            NULL,
                mood            VARCHAR(50)     NULL,
                source          VARCHAR(50)     NULL,
                meta_json       TEXT            NULL,
                PRIMARY KEY  (id),
                KEY created_at (created_at),
                KEY mood       (mood)
            ) {$charset_collate};
        ";

        $sql_neighbors = "
            CREATE TABLE {$neighbor_table} (
                id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                created_at      DATETIME        NOT NULL,
                ip_hash         CHAR(64)        NULL,
                user_agent      VARCHAR(255)    NULL,
                nominee_name    VARCHAR(150)    NOT NULL,
                nominee_contact VARCHAR(255)    NULL,
                nominator_name  VARCHAR(150)    NULL,
                story           TEXT            NOT NULL,
                need_type       VARCHAR(100)    NULL,
                meta_json       TEXT            NULL,
                PRIMARY KEY  (id),
                KEY created_at (created_at),
                KEY need_type  (need_type)
            ) {$charset_collate};
        ";

        $sql_presence = "
            CREATE TABLE {$presence_table} (
                id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                session_key     CHAR(36)        NOT NULL,
                first_seen      DATETIME        NOT NULL,
                last_seen       DATETIME        NOT NULL,
                ip_hash         CHAR(64)        NULL,
                user_agent      VARCHAR(255)    NULL,
                PRIMARY KEY  (id),
                UNIQUE KEY session_key (session_key),
                KEY last_seen (last_seen)
            ) {$charset_collate};
        ";

        dbDelta($sql_glows);
        dbDelta($sql_neighbors);
        dbDelta($sql_presence);
    }

    /**
     * Compute a simple presence summary for the last few minutes.
     */
    protected static function compute_presence_summary() {
        global $wpdb;

        self::ensure_tables();

        $presence_table = $wpdb->prefix . 'lof_presence_sessions';

        // Consider sessions "active" if pinged in the last 10 minutes.
        $cutoff_ts   = current_time('timestamp') - (10 * 60);
        $cutoff_date = gmdate('Y-m-d H:i:s', $cutoff_ts);

        $count = (int) $wpdb->get_var(
            $wpdb->prepare(
                "SELECT COUNT(*) FROM {$presence_table} WHERE last_seen >= %s",
                $cutoff_date
            )
        );

        if ($count <= 1) {
            $bucket = 'solo';
        } elseif ($count <= 4) {
            $bucket = 'small';
        } elseif ($count <= 12) {
            $bucket = 'party';
        } else {
            $bucket = 'packed';
        }

        return [
            'count'      => $count,
            'bucket'     => $bucket,
            'updated_at' => current_time('mysql', true),
        ];
    }

    /**
     * REST: POST /lof-extras/v1/presence/ping
     * Called periodically by the viewer to say "I'm still here".
     */
    public static function presence_ping(\WP_REST_Request $request) {
        global $wpdb;

        self::ensure_tables();

        $params      = $request->get_json_params();
        $session_key = isset($params['session_key']) ? sanitize_text_field($params['session_key']) : '';

        if ($session_key === '') {
            return new \WP_REST_Response(
                ['success' => false, 'message' => 'Missing session_key'],
                400
            );
        }

        $presence_table = $wpdb->prefix . 'lof_presence_sessions';

        $ip         = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';
        $ip_hash    = $ip ? wp_hash($ip) : null;
        $user_agent = isset($_SERVER['HTTP_USER_AGENT']) ? substr($_SERVER['HTTP_USER_AGENT'], 0, 255) : '';

        $now = current_time('mysql');

        // Upsert-ish behavior using REPLACE INTO.
        $wpdb->replace(
            $presence_table,
            [
                'session_key' => $session_key,
                'first_seen'  => $now,
                'last_seen'   => $now,
                'ip_hash'     => $ip_hash,
                'user_agent'  => $user_agent,
            ],
            [
                '%s',
                '%s',
                '%s',
                '%s',
                '%s',
            ]
        );

        // Clean up old sessions.
        $cutoff_ts   = current_time('timestamp') - (10 * 60);
        $cutoff_date = gmdate('Y-m-d H:i:s', $cutoff_ts);

        $wpdb->query(
            $wpdb->prepare(
                "DELETE FROM {$presence_table} WHERE last_seen < %s",
                $cutoff_date
            )
        );

        return new \WP_REST_Response(
            ['success' => true],
            200
        );
    }

    /**
     * REST: GET /lof-extras/v1/presence/summary
     */
    public static function presence_summary(\WP_REST_Request $request) {
        $summary = self::compute_presence_summary();

        return new \WP_REST_Response($summary, 200);
    }

    /**
     * REST: POST /lof-extras/v1/glow
     * Save a small "glow" message from the viewer.
     */
    public static function handle_glow(\WP_REST_Request $request) {
        global $wpdb;

        self::ensure_tables();

        $params = $request->get_json_params();

        $message = isset($params['message']) ? trim(wp_kses_post($params['message'])) : '';
        $from    = isset($params['from_name']) ? sanitize_text_field($params['from_name']) : '';
        $to      = isset($params['to_name']) ? sanitize_text_field($params['to_name']) : '';
        $rel     = isset($params['relationship']) ? sanitize_text_field($params['relationship']) : '';
        $mood    = isset($params['mood']) ? sanitize_text_field($params['mood']) : '';
        $source  = isset($params['source']) ? sanitize_text_field($params['source']) : 'viewer_page';

        if ($message === '') {
            return new \WP_REST_Response(
                ['success' => false, 'message' => 'Message is required.'],
                400
            );
        }

        $ip         = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';
        $ip_hash    = $ip ? wp_hash($ip) : null;
        $user_agent = isset($_SERVER['HTTP_USER_AGENT']) ? substr($_SERVER['HTTP_USER_AGENT'], 0, 255) : '';

        $table = $wpdb->prefix . 'lof_glows';

        $wpdb->insert(
            $table,
            [
                'created_at'   => current_time('mysql'),
                'ip_hash'      => $ip_hash,
                'user_agent'   => $user_agent,
                'from_name'    => $from,
                'to_name'      => $to,
                'relationship' => $rel,
                'message'      => $message,
                'mood'         => $mood,
                'source'       => $source,
                'meta_json'    => null,
            ],
            [
                '%s',
                '%s',
                '%s',
                '%s',
                '%s',
                '%s',
                '%s',
                '%s',
                '%s',
            ]
        );

        if (!$wpdb->insert_id) {
            return new \WP_REST_Response(
                ['success' => false, 'message' => 'Could not save glow.'],
                500
            );
        }

        return new \WP_REST_Response(
            ['success' => true],
            200
        );
    }

    /**
     * REST: POST /lof-extras/v1/neighbor
     * Save a "Nominate a Neighbor" story.
     */
    public static function handle_neighbor(\WP_REST_Request $request) {
        global $wpdb;

        self::ensure_tables();

        $params = $request->get_json_params();

        $nominee_name    = isset($params['nominee_name']) ? sanitize_text_field($params['nominee_name']) : '';
        $nominee_contact = isset($params['nominee_contact']) ? sanitize_text_field($params['nominee_contact']) : '';
        $nominator_name  = isset($params['nominator_name']) ? sanitize_text_field($params['nominator_name']) : '';
        $story           = isset($params['story']) ? trim(wp_kses_post($params['story'])) : '';
        $need_type       = isset($params['need_type']) ? sanitize_text_field($params['need_type']) : '';
        $meta            = isset($params['meta']) && is_array($params['meta']) ? $params['meta'] : [];

        if ($nominee_name === '' || $story === '') {
            return new \WP_REST_Response(
                ['success' => false, 'message' => 'Nominee name and story are required.'],
                400
            );
        }

        $ip         = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';
        $ip_hash    = $ip ? wp_hash($ip) : null;
        $user_agent = isset($_SERVER['HTTP_USER_AGENT']) ? substr($_SERVER['HTTP_USER_AGENT'], 0, 255) : '';

        $table = $wpdb->prefix . 'lof_neighbor_nominations';

        $wpdb->insert(
            $table,
            [
                'created_at'      => current_time('mysql'),
                'ip_hash'         => $ip_hash,
                'user_agent'      => $user_agent,
                'nominee_name'    => $nominee_name,
                'nominee_contact' => $nominee_contact,
                'nominator_name'  => $nominator_name,
                'story'           => $story,
                'need_type'       => $need_type,
                'meta_json'       => $meta ? wp_json_encode($meta) : null,
            ],
            [
                '%s',
                '%s',
                '%s',
                '%s',
                '%s',
                '%s',
                '%s',
                '%s',
                '%s',
            ]
        );

        if (!$wpdb->insert_id) {
            return new \WP_REST_Response(
                ['success' => false, 'message' => 'Could not save nomination.'],
                500
            );
        }

        return new \WP_REST_Response(
            ['success' => true],
            200
        );
    }

}