<?php

if (!defined('ABSPATH')) {
    exit;
}

class LOF_Glow {

    public static function init() {
        add_action('rest_api_init', function () {

            register_rest_route('lof-extras/v1', '/glow', [
                'methods'             => 'POST',
                'callback'            => [__CLASS__, 'send_glow'],
            ]);
        });
    }

    public static function send_glow(\WP_REST_Request $request) {
        $message = trim((string) $request->get_param('message'));
        $name    = trim((string) $request->get_param('name'));

        if ($message === '') {
            return new \WP_REST_Response([
                'success' => false,
                'message' => 'Message is required.',
            ], 400);
        }

        if (mb_strlen($message) > 500) {
            $message = mb_substr($message, 0, 500);
        }

        $entry = [
            'ts'      => current_time('c'),
            'ip'      => isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '',
            'ua'      => isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '',
            'name'    => $name,
            'message' => $message,
        ];

        $logFile = dirname(__DIR__) . '/lof-glow-log.jsonl';
        $line    = wp_json_encode($entry, JSON_UNESCAPED_UNICODE) . "\n";

        $ok = @file_put_contents($logFile, $line, FILE_APPEND | LOCK_EX);

        if ($ok === false) {
            return new \WP_REST_Response([
                'success' => false,
                'message' => 'Could not write glow log.',
            ], 500);
        }

        return [
            'success' => true,
            'message' => 'Glow received',
        ];
    }
}