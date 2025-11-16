<?php

if (!defined('ABSPATH')) exit;

class LOF_API {

    public static function init() {
        add_action('rest_api_init', function() {

            register_rest_route('lof-extras/v1', '/viewer-config', [
                'methods'  => 'GET',
                'callback' => [__CLASS__, 'viewer_config'],
                'permission_callback' => '__return_true'
            ]);

        });
    }

    public static function viewer_config() {

        $settings = get_option('lof_extras_settings', []);

        return [
            'holiday_mode' => $settings['holiday_mode'] ?? 'offseason',
            'features' => [
                'glow'    => !empty($settings['enable_glow']),
                'speaker' => !empty($settings['enable_speaker']),
            ],
            'copy' => [
                // Will expand with all copy lines in next steps
                'banner_showtime_title' => 'Showtime 🎶',
                'banner_showtime_sub'   => 'Enjoy the synced magic!',
            ],
            'showtimes' => [
                // Placeholder windows
                ['start' => '17:00', 'end' => '21:00']
            ],
            'speaker' => [
                'minutes_default' => 5,
                'max_extension'   => 180,
                'cooldown'        => 15
            ]
        ];
    }
}