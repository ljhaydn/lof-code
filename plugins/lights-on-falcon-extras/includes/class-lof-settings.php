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
            'Lights On Falcon Extras',
            'LOF Extras',
            'manage_options',
            'lof-extras',
            [__CLASS__, 'settings_page'],
            'dashicons-lightbulb'
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
        self::add_checkbox_field('lof_general', 'enable_surprise_me', 'Enable "Surprise Me"');
        self::add_checkbox_field('lof_general', 'enable_glow', 'Enable "Send a Glow"');
        self::add_checkbox_field('lof_general', 'enable_speaker', 'Enable Speaker Control');
        self::add_checkbox_field('lof_general', 'enable_fog', 'Enable Fog / FX Button (future)');

        self::add_textarea_field(
            'lof_general',
            'showtimes_json',
            'Showtime Windows (JSON)',
            "Example:\n[\n  {\"start\":\"17:00\",\"end\":\"21:00\"},\n  {\"start\":\"21:30\",\"end\":\"23:00\"}\n]"
        );

        // SPEAKER LOGIC
        add_settings_section(
            'lof_speaker_logic',
            'Speaker Logic Settings',
            function () {
                echo '<p>Control how long speakers stay on and how aggressive extensions are. Timing logic will eventually use these values.</p>';
            },
            'lof-extras'
        );

        self::add_number_field('lof_speaker_logic', 'speaker_minutes_default', 'Default ON Duration (minutes)', 5);
        self::add_number_field('lof_speaker_logic', 'speaker_max_extension', 'Max Extension (seconds)', 180);
        self::add_number_field('lof_speaker_logic', 'speaker_cooldown', 'Cooldown Between Presses (seconds)', 15);

        // BANNER COPY
        add_settings_section(
            'lof_copy_banner',
            'Banner Copy',
            function () {
                echo '<p>Text shown in the top banners for different phases (showtime, intermission, after-hours, offseason).</p>';
            },
            'lof-extras'
        );

        self::add_text_field('lof_copy_banner', 'banner_showtime_title', 'Showtime Title', 'Showtime 🎶');
        self::add_textarea_field('lof_copy_banner', 'banner_showtime_sub', 'Showtime Subtitle', '');
        self::add_text_field('lof_copy_banner', 'banner_intermission_title', 'Intermission Title', 'Intermission');
        self::add_textarea_field('lof_copy_banner', 'banner_intermission_sub', 'Intermission Subtitle', '');
        self::add_text_field('lof_copy_banner', 'banner_afterhours_title', 'After-hours Title', 'We’re taking a breather');
        self::add_textarea_field('lof_copy_banner', 'banner_afterhours_sub', 'After-hours Subtitle', '');
        self::add_text_field('lof_copy_banner', 'banner_offseason_title', 'Offseason Title', 'We’re resting up for next season');
        self::add_textarea_field('lof_copy_banner', 'banner_offseason_sub', 'Offseason Subtitle', '');

        // SPEAKER COPY
        add_settings_section(
            'lof_copy_speaker',
            'Speaker Copy',
            function () {
                echo '<p>Copy for the speaker control card and status messages.</p>';
            },
            'lof-extras'
        );

        self::add_text_field('lof_copy_speaker', 'speaker_btn_on', 'Button Text (Turn On)', 'Turn speakers on 🔊');
        self::add_text_field('lof_copy_speaker', 'speaker_btn_off', 'Button Text (Turn Off)', 'Turn speakers off');
        self::add_textarea_field('lof_copy_speaker', 'speaker_status_on', 'Status Text (ON)', 'Speakers are currently ON near the show.');
        self::add_textarea_field('lof_copy_speaker', 'speaker_status_off', 'Status Text (OFF)', 'Speakers are currently OFF.');
        self::add_textarea_field('lof_copy_speaker', 'speaker_status_unknown', 'Status Text (Unknown)', 'Unable to read speaker status.');
        self::add_text_field('lof_copy_speaker', 'speaker_time_left_prefix', 'Time Left Prefix', 'Time left:');
        self::add_textarea_field('lof_copy_speaker', 'speaker_error_msg', 'Generic Error Message', 'Something glitched while talking to the speakers.');

        // GLOW COPY
        add_settings_section(
            'lof_copy_glow',
            'Glow Card Copy',
            function () {
                echo '<p>Copy for the “Send a Glow” community micro-moment card.</p>';
            },
            'lof-extras'
        );

        self::add_text_field('lof_copy_glow', 'glow_title', 'Title', 'Send a little glow 💚');
        self::add_textarea_field('lof_copy_glow', 'glow_sub', 'Subtitle', 'Drop a short note of thanks, joy, or encouragement.');
        self::add_textarea_field('lof_copy_glow', 'glow_placeholder', 'Message Placeholder', 'Tell us who made your night, or what made you smile…');
        self::add_text_field('lof_copy_glow', 'glow_name_placeholder', 'Name Placeholder', 'Name or initials (optional)');
        self::add_text_field('lof_copy_glow', 'glow_btn', 'Button Text', 'Send this glow ✨');
        self::add_text_field('lof_copy_glow', 'glow_success_toast', 'Success Toast', 'Glow sent. Thanks for sharing the love. 💚');
        self::add_text_field('lof_copy_glow', 'glow_error_toast', 'Error Toast', 'Error Toast', 'Could not send glow. Please try again.');
        self::add_textarea_field('lof_copy_glow', 'glow_disabled_text', 'Disabled Text', 'Glow sending is currently paused.');

        // SURPRISE ME COPY
        add_settings_section(
            'lof_copy_surprise',
            'Surprise Me Copy',
            function () {
                echo '<p>Copy for the “Surprise me” card and responses.</p>';
            },
            'lof-extras'
        );

        self::add_text_field('lof_copy_surprise', 'surprise_title', 'Title', 'Can’t pick just one?');
        self::add_textarea_field('lof_copy_surprise', 'surprise_sub', 'Subtitle', 'Let us queue up a random crowd-pleaser for you.');
        self::add_text_field('lof_copy_surprise', 'surprise_btn', 'Button Text', 'Surprise me ✨');
        self::add_text_field('lof_copy_surprise', 'surprise_success', 'Success Toast', 'Request sent! You’re in the queue.');
        self::add_text_field('lof_copy_surprise', 'surprise_fourth_time', 'Fourth-time Toast', 'You like chaos. We respect that. 😈');
        self::add_textarea_field('lof_copy_surprise', 'surprise_disabled', 'Disabled Text', 'Viewer control is currently paused.');

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

    /**
     * Helpers to define fields
     */

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

    public static function get($key, $default = null) {
        $options = get_option(self::OPTION_NAME, []);
        return isset($options[$key]) ? $options[$key] : $default;
    }

    public static function get_bool($key, $default = false) {
        $val = self::get($key, $default);
        return !empty($val);
    }

    /**
     * Field renderers
     */

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
        $value = self::get_bool($key, false);
        $checked = $value ? "checked='checked'" : '';
        printf(
            "<label><input type='checkbox' name='%s[%s]' value='1' %s /> Enabled</label>",
            esc_attr(self::OPTION_NAME),
            esc_attr($key),
            $checked
        );
    }

    public static function settings_page() {
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