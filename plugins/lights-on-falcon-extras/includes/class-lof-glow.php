<?php

if (!defined('ABSPATH')) exit;

class LOF_Glow {

    public static function init() {
        add_action('rest_api_init', function() {

            register_rest_route('lof-extras/v1', '/glow', [
                'methods'  => 'POST',
                'callback' => [__CLASS__, 'send_glow'],
                'permission_callback' => '__return_true'
            ]);

        });
    }

    public static function send_glow($request) {

        $msg = sanitize_text_field($request['message'] ?? '');
        $name = sanitize_text_field($request['name'] ?? '');

        if (!$msg) {
            return [
                'success' => false,
                'message' => 'Message required.'
            ];
        }

        // Write JSONL later
        return [
            'success' => true,
            'message' => 'Glow received'
        ];
    }
}