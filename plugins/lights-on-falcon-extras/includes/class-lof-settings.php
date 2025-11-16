<?php
/**
 * Lights On Falcon - Settings (Phase A)
 * REAL IMPLEMENTATION
 */

if (!defined('ABSPATH')) exit;

class LOF_Settings {

    public function __construct() {
        add_action('admin_init', [$this, 'register']);
    }

    public function register() {

        add_settings_section(
            'lof_settings_fpp',
            'Lights On Falcon - FPP Integration',
            function() {
                echo '<p>Configure FPP integration and show-state overrides.</p>';
            },
            'lof_extras'
        );

        // FPP Base URL
        add_settings_field(
            'lof_fpp_base_url',
            'FPP Base URL',
            function() {
                $val = esc_attr(get_option('lof_fpp_base_url', 'http://10.9.7.102'));
                echo "<input type='text' name='lof_fpp_base_url' value='{$val}' class='regular-text' />";
            },
            'lof_extras',
            'lof_settings_fpp'
        );
        register_setting('lof_extras', 'lof_fpp_base_url');

        // Manual Override
        add_settings_field(
            'lof_manual_phase_override',
            'Manual Phase Override',
            function() {
                $val = get_option('lof_manual_phase_override', 'auto');
                $opts = [
                    'auto' => 'AUTO (Recommended)',
                    'force_pre_show' => 'Force Pre-show',
                    'force_showtime' => 'Force Showtime',
                    'force_intermission' => 'Force Intermission',
                    'force_drop_by' => 'Force Drop-By',
                    'force_after_show' => 'Force After-Show',
                    'force_off_hours' => 'Force Off-Hours',
                    'force_off_season' => 'Force Off-Season',
                    'force_maintenance' => 'Force Maintenance'
                ];

                echo "<select name='lof_manual_phase_override'>";
                foreach ($opts as $key => $label) {
                    echo "<option value='{$key}' " . selected($val, $key, false) . ">{$label}</option>";
                }
                echo "</select>";
                echo "<p class='description'>This overrides automatic detection.</p>";
            },
            'lof_extras',
            'lof_settings_fpp'
        );
        register_setting('lof_extras', 'lof_manual_phase_override');
    }
}

new LOF_Settings();
