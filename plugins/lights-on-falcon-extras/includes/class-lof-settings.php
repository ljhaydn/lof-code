<?php

if (!defined('ABSPATH')) {
    exit;
}

class LOF_Settings {

    const OPTION_GROUP = 'lof_extras_options';
    const OPTION_NAME  = 'lof_extras_settings';

    public static function init() {
        add_action('admin_menu', [__CLASS__, 'add_menu']);
        add_action('admin_init', [__CLASS__, 'register_settings']);
    }

    public static function add_menu() {
        add_menu_page(
            'Lights On Falcon - Extras',
            'LOF Extras',
            'manage_options',
            'lof-extras',
            [__CLASS__, 'render_settings_page'],
            'dashicons-lightbulb',
            80
        );
    }

    public static function register_settings() {
        register_setting(self::OPTION_GROUP, self::OPTION_NAME);

        // GENERAL
        add_settings_section(
            'lof_general',
            'General Viewer Settings',
            function () {
                echo '<p>Core configuration that applies across the Lights on Falcon viewer experience.</p>';
            },
            'lof-extras'
        );

        self::add_text_field('lof_general', 'holiday_mode', 'Holiday Mode', 'christmas, halloween, offseason…');
        self::add_checkbox_field('lof_general', 'enable_surprise_me', 'Enable “Surprise Me” card');
        self::add_checkbox_field('lof_general', 'enable_glow', 'Enable “Send a glow” card');
        self::add_checkbox_field('lof_general', 'enable_speaker', 'Enable speaker card');
        self::add_checkbox_field('lof_general', 'enable_fog', 'Enable fog machine control (future)');

        self::add_textarea_field(
            'lof_general',
            'showtimes_json',
            'Showtime Windows (JSON)',
            '[
  { "start": "17:00", "end": "21:00" }
]'
        );

        // SPEAKER SETTINGS
        add_settings_section(
            'lof_speaker',
            'Speaker Control',
            function () {
                echo '<p>Timing and behavior for the “Need sound?” speaker button.</p>';
            },
            'lof-extras'
        );

        self::add_number_field('lof_speaker', 'speaker_minutes_default', 'Default minutes on', 5);
        self::add_number_field('lof_speaker', 'speaker_max_extension', 'Max auto-extension (seconds)', 180);
        self::add_number_field('lof_speaker', 'speaker_cooldown', 'Cooldown between presses (seconds)', 15);

        self::add_text_field('lof_speaker', 'speaker_btn_on', 'Button Label – ON', 'Turn speakers on 🔊');
        self::add_text_field('lof_speaker', 'speaker_btn_off', 'Button Label – OFF', 'Turn speakers off');
        self::add_textarea_field('lof_speaker', 'speaker_status_on', 'Status Text – ON', 'Speakers are currently ON near the show.');
        self::add_textarea_field('lof_speaker', 'speaker_status_off', 'Status Text – OFF', 'Speakers are currently OFF. If you’re standing at the show, you can turn them on.');
        self::add_textarea_field('lof_speaker', 'speaker_status_unknown', 'Status Text – Unknown', 'Unable to read speaker status.');
        self::add_text_field('lof_speaker', 'speaker_time_left_prefix', 'Time left prefix', 'Time left:');
        self::add_textarea_field('lof_speaker', 'speaker_error_msg', 'Error Toast', 'Something glitched while talking to the speakers.');

        // GLOW SETTINGS
        add_settings_section(
            'lof_glow',
            '“Send a glow” Settings',
            function () {
                echo '<p>Control how the glow form behaves and what it says.</p>';
            },
            'lof-extras'
        );

        self::add_text_field('lof_glow', 'glow_title', 'Title', 'Send a little glow 💚');
        self::add_textarea_field('lof_glow', 'glow_sub', 'Subtitle', 'Drop a short note of thanks, joy, or encouragement.');
        self::add_textarea_field('lof_glow', 'glow_placeholder', 'Message Placeholder', 'Tell us who made your night, or what made you smile…');
        self::add_text_field('lof_glow', 'glow_name_placeholder', 'Name Placeholder', 'Name or initials (optional)');
        self::add_text_field('lof_glow', 'glow_btn', 'Button Label', 'Send this glow ✨');
        self::add_text_field('lof_glow', 'glow_success_toast', 'Success Toast', 'Glow sent. Thanks for sharing the love. 💚');
        self::add_text_field('lof_glow', 'glow_error_toast', 'Error Toast', 'Could not send glow. Please try again.');
        self::add_text_field('lof_glow', 'glow_too_short', 'Too-short Message', 'Give us a little more than that. 🙂');
        self::add_text_field('lof_glow', 'glow_too_long', 'Too-long Message', 'That\'s a bit too long for a quick glow.');
        self::add_text_field('lof_glow', 'glow_rate_limited', 'Rate-limit Message', 'You just sent a glow. Give it a minute before sending another.');

        // SURPRISE ME COPY
        add_settings_section(
            'lof_copy_surprise',
            '“Surprise Me” Copy',
            function () {
                echo '<p>Copy for the Surprise Me card and related messaging.</p>';
            },
            'lof-extras'
        );

        self::add_text_field('lof_copy_surprise', 'surprise_title', 'Title', 'Can’t pick just one?');
        self::add_textarea_field('lof_copy_surprise', 'surprise_sub', 'Subtitle', 'Let us queue up a random crowd-pleaser for you.');
        self::add_text_field('lof_copy_surprise', 'surprise_btn', 'Button Text', 'Surprise me ✨');
        self::add_text_field('lof_copy_surprise', 'surprise_success', 'Success Toast', 'Request sent! You’re in the queue.');
        self::add_text_field('lof_copy_surprise', 'surprise_fourth_time', 'Fourth-time Toast', 'You like chaos. We respect that. 😈');
        self::add_textarea_field('lof_copy_surprise', 'surprise_disabled', 'Disabled Text', 'Viewer control is currently paused.');

        // HEADER COPY (viewer hero)
        add_settings_section(
            'lof_copy_header',
            'Header Copy',
            function () {
                echo '<p>Copy for the hero header at the top of the viewer page.</p>';
            },
            'lof-extras'
        );

        self::add_text_field(
            'lof_copy_header',
            'header_jukebox_title',
            'Jukebox Mode – Headline',
            'Tap a song to request it 🎧'
        );
        self::add_textarea_field(
            'lof_copy_header',
            'header_jukebox_intro',
            'Jukebox Mode – Intro',
            'Requests join the queue in the order they come in.'
        );
        self::add_textarea_field(
            'lof_copy_header',
            'header_jukebox_queue',
            'Jukebox Mode – Queue Line',
            'There are currently {queueCount} songs in the queue.'
        );
        self::add_textarea_field(
            'lof_copy_header',
            'header_jukebox_limit',
            'Jukebox Mode – Request Limit Line',
            'You can request up to {requestLimit} songs per session.'
        );
        self::add_textarea_field(
            'lof_copy_header',
            'header_jukebox_geo',
            'Jukebox Mode – Location Line',
            'Viewer control may be limited to guests near the show location.'
        );
        self::add_textarea_field(
            'lof_copy_header',
            'header_jukebox_late',
            'Jukebox Mode – Late-night Line',
            'Late-night Falcon fans are the real MVPs. 🌙'
        );

        self::add_text_field(
            'lof_copy_header',
            'header_voting_title',
            'Voting Mode – Headline',
            'Vote for your favorites 🗳️'
        );
        self::add_textarea_field(
            'lof_copy_header',
            'header_voting_intro',
            'Voting Mode – Intro',
            'Songs with the most votes rise to the top. Tap a track below to help decide what plays next.'
        );
        self::add_textarea_field(
            'lof_copy_header',
            'header_voting_late',
            'Voting Mode – Late-night Line',
            'Bonus points for after-dark voting energy. 🌒'
        );

        self::add_text_field(
            'lof_copy_header',
            'header_paused_title',
            'Paused – Headline',
            'Viewer control is currently paused'
        );
        self::add_textarea_field(
            'lof_copy_header',
            'header_paused_body',
            'Paused – Body',
            'You can still enjoy the show — we’ll turn song requests and voting back on soon.'
        );

        self::add_text_field(
            'lof_copy_header',
            'header_default_title',
            'Fallback – Headline',
            'Interactive show controls'
        );
        self::add_textarea_field(
            'lof_copy_header',
            'header_default_body',
            'Fallback – Body',
            'Use the controls below to interact with the Lights on Falcon show in real time.'
        );

        // STATS COPY
        add_settings_section(
            'lof_copy_stats',
            'Stats Copy',
            function () {
                echo '<p>Copy for the small “Tonight from this device” stats block.</p>';
            },
            'lof-extras'
        );

        self::add_text_field('lof_copy_stats', 'stats_title', 'Stats Title', 'Tonight from this device');
        self::add_text_field('lof_copy_stats', 'stats_requests_label', 'Requests Label', 'Requests sent');
        self::add_text_field('lof_copy_stats', 'stats_surprise_label', 'Surprise Label', '“Surprise me” taps');
        self::add_text_field('lof_copy_stats', 'stats_vibe_label', 'Vibe Label', 'Falcon vibe check');
        self::add_text_field('lof_copy_stats', 'stats_vibe_low', 'Vibe (Low)', 'Cozy & chill 😌');
        self::add_text_field('lof_copy_stats', 'stats_vibe_med', 'Vibe (Medium)', 'Party forming 🕺');
        self::add_text_field('lof_copy_stats', 'stats_vibe_high', 'Vibe (High)', 'Full-send Falcon 🔥');
    }

    /* -------------------------
     * Helpers for getting values
     * ------------------------- */

    public static function get($key, $default = '') {
        $settings = get_option(self::OPTION_NAME, []);
        return isset($settings[$key]) && $settings[$key] !== '' ? $settings[$key] : $default;
    }

    /* -------------------------
     * Field helpers
     * ------------------------- */

    protected static function add_text_field($section, $key, $label, $placeholder = '') {
        add_settings_field(
            $key,
            esc_html($label),
            [__CLASS__, 'field_text'],
            'lof-extras',
            $section,
            [
                'key'         => $key,
                'placeholder' => $placeholder,
            ]
        );
    }

    protected static function add_textarea_field($section, $key, $label, $placeholder = '') {
        add_settings_field(
            $key,
            esc_html($label),
            [__CLASS__, 'field_textarea'],
            'lof-extras',
            $section,
            [
                'key'         => $key,
                'placeholder' => $placeholder,
            ]
        );
    }

    protected static function add_number_field($section, $key, $label, $placeholder = '') {
        add_settings_field(
            $key,
            esc_html($label),
            [__CLASS__, 'field_number'],
            'lof-extras',
            $section,
            [
                'key'         => $key,
                'placeholder' => $placeholder,
            ]
        );
    }

    protected static function add_checkbox_field($section, $key, $label) {
        add_settings_field(
            $key,
            esc_html($label),
            [__CLASS__, 'field_checkbox'],
            'lof-extras',
            $section,
            [
                'key' => $key,
            ]
        );
    }

    public static function field_text($args) {
        $key   = $args['key'];
        $value = esc_attr(self::get($key, ''));
        $placeholder = isset($args['placeholder']) ? esc_attr($args['placeholder']) : '';
        printf(
            "<input type='text' name='%s[%s]' value='%s' placeholder='%s' class='regular-text' />",
            esc_attr(self::OPTION_NAME),
            esc_attr($key),
            $value,
            $placeholder
        );
    }

    public static function field_number($args) {
        $key   = $args['key'];
        $value = esc_attr(self::get($key, ''));
        $placeholder = isset($args['placeholder']) ? esc_attr($args['placeholder']) : '';
        printf(
            "<input type='number' name='%s[%s]' value='%s' placeholder='%s' class='small-text' />",
            esc_attr(self::OPTION_NAME),
            esc_attr($key),
            $value,
            $placeholder
        );
    }

    public static function field_textarea($args) {
        $key   = $args['key'];
        $value = esc_textarea(self::get($key, ''));
        $placeholder = isset($args['placeholder']) ? esc_textarea($args['placeholder']) : '';
        printf(
            "<textarea name='%s[%s]' rows='3' class='large-text' placeholder='%s'>%s</textarea>",
            esc_attr(self::OPTION_NAME),
            esc_attr($key),
            $placeholder,
            $value
        );
    }

    public static function field_checkbox($args) {
        $key   = $args['key'];
        $value = self::get($key, '');
        printf(
            "<label><input type='checkbox' name='%s[%s]' value='1' %s /> %s</label>",
            esc_attr(self::OPTION_NAME),
            esc_attr($key),
            checked($value, '1', false),
            esc_html__('Enabled', 'lof-extras')
        );
    }

    public static function render_settings_page() {
        ?>
        <div class="wrap">
            <h1>Lights On Falcon - Extras</h1>
            <p>This plugin centralizes the configuration and APIs that power the Lights on Falcon “epic viewer” experience.</p>
            <form method="post" action="options.php">
                <?php
                settings_fields(self::OPTION_GROUP);
                do_settings_sections('lof-extras');
                submit_button();
                ?>
            </form>
        </div>
        <?php
    }
}