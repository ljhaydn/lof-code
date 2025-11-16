<?php

if (!defined('ABSPATH')) exit;

class LOF_Speaker {

    public static function init() {
        add_action('rest_api_init', function() {

            register_rest_route('lof-extras/v1', '/speaker/status', [
                'methods'  => 'GET',
                'callback' => [__CLASS__, 'status'],
                'permission_callback' => '__return_true'
            ]);

            register_rest_route('lof-extras/v1', '/speaker/on', [
                'methods'  => 'POST',
                'callback' => [__CLASS__, 'turn_on'],
                'permission_callback' => '__return_true'
            ]);

        });
    }

    public static function status() {
        return [
            'speakerOn' => false,
            'remainingSeconds' => 0
        ];
    }

    public static function turn_on() {
        return [
            'success' => true,
            'message' => 'Speaker command received.'
        ];
    }
}