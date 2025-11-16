<?php

if (!defined('ABSPATH')) exit;

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

        add_settings_section(
            'lof_general',
            'General Viewer Settings',
            function() {
                echo '<p>Configure core settings for the Lights on Falcon viewer experience.</p>';
            },
            'lof-extras'
        );

        add_settings_field(
            'holiday_mode',
            'Holiday Mode',
            [__CLASS__, 'field_text'],
            'lof-extras',
            'lof_general',
            [
                'key'   => 'holiday_mode',
                'placeholder' => 'christmas, halloween, offseason…'
            ]
        );

        add_settings_field(
            'enable_glow',
            'Enable Glow',
            [__CLASS__, 'field_checkbox'],
            'lof-extras',
            'lof_general',
            [ 'key' => 'enable_glow' ]
        );

        add_settings_field(
            'enable_speaker',
            'Enable Speaker Control',
            [__CLASS__, 'field_checkbox'],
            'lof-extras',
            'lof_general',
            [ 'key' => 'enable_speaker' ]
        );
    }

    public static function get($key, $default = null) {
        $options = get_option(self::OPTION_NAME, []);
        return isset($options[$key]) ? $options[$key] : $default;
    }

    // Basic text field
    public static function field_text($args) {
        $key = $args['key'];
        $value = esc_attr(self::get($key, ''));
        $placeholder = isset($args['placeholder']) ? $args['placeholder'] : '';

        echo "<input type='text' name='".self::OPTION_NAME."[$key]' value='$value' placeholder='$placeholder' class='regular-text' />";
    }

    // Checkbox field
    public static function field_checkbox($args) {
        $key = $args['key'];
        $value = self::get($key, false);
        $checked = $value ? "checked" : "";
        echo "<label><input type='checkbox' name='".self::OPTION_NAME."[$key]' value='1' $checked> Enabled</label>";
    }

    public static function settings_page() {
        ?>
        <div class="wrap">
            <h1>Lights On Falcon - Extras</h1>

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