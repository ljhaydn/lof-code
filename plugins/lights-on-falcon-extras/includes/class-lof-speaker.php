<?php

if (!defined('ABSPATH')) {
    exit;
}

class LOF_Speaker {

    const OPTION_STATE = 'lof_extras_speaker_state';

    public static function init() {
        // Viewer 1.5:
        // Freeze LOF_Speaker REST endpoints so we don't have two competing
        // speaker systems. Speaker control for this season is handled by the
        // theme-based lof-speaker.php controller.
        //
        // This keeps the class available for future use (e.g., Viewer V2),
        // but prevents its routes from being registered in the current setup.
        return;

        // Original route registration left here for future reference:
        /*
        add_action('rest_api_init', function () {

            register_rest_route('lof-extras/v1', '/speaker/status', [
                'methods'             => 'GET',
                'callback'            => [__CLASS__, 'status'],
                'permission_callback' => '__return_true',
            ]);

            register_rest_route('lof-extras/v1', '/speaker/on', [
                'methods'             => 'POST',
                'callback'            => [__CLASS__, 'turn_on'],
                'permission_callback' => '__return_true',
            ]);

        });
        */
    }

    protected static function get_state() {
        $state = get_option(self::OPTION_STATE, []);
        $defaults = [
            'speaker_on'  => false,
            'off_at'      => 0,
            'last_on_at'  => 0,
            'last_off_at' => 0,
        ];
        return array_merge($defaults, is_array($state) ? $state : []);
    }

    protected static function save_state($state) {
        if (!is_array($state)) {
            $state = [];
        }
        update_option(self::OPTION_STATE, $state, false);
    }

    public static function status(\WP_REST_Request $request) {
        $state = self::get_state();
        $now   = time();

        $on    = !empty($state['speaker_on']);
        $offAt = isset($state['off_at']) ? (int) $state['off_at'] : 0;

        if ($on && $offAt > 0 && $offAt <= $now) {
            // Timer expired; mark as off in state.
            $on = false;
            $state['speaker_on'] = false;
            self::save_state($state);
        }

        $remaining = 0;
        if ($on && $offAt > $now) {
            $remaining = $offAt - $now;
        }

        return [
            'speakerOn'        => $on,
            'remainingSeconds' => $remaining,
        ];
    }

    public static function turn_on(\WP_REST_Request $request) {
        $settings = get_option(LOF_Settings::OPTION_NAME, []);

        $minutesDefault = isset($settings['speaker_minutes_default']) && is_numeric($settings['speaker_minutes_default'])
            ? max(1, (int) $settings['speaker_minutes_default'])
            : 5;

        $maxExtension   = isset($settings['speaker_max_extension']) && is_numeric($settings['speaker_max_extension'])
            ? max(0, (int) $settings['speaker_max_extension'])
            : 180;

        $cooldown       = isset($settings['speaker_cooldown']) && is_numeric($settings['speaker_cooldown'])
            ? max(0, (int) $settings['speaker_cooldown'])
            : 15;

        $songRemaining  = (int) $request->get_param('songRemainingSeconds');

        $state = self::get_state();
        $now   = time();

        // Basic cooldown
        if (!empty($state['last_on_at']) && ($now - (int) $state['last_on_at']) < $cooldown) {
            $secondsLeft = $cooldown - ($now - (int) $state['last_on_at']);
            return [
                'success' => false,
                'message' => 'Please wait ' . $secondsLeft . 's before turning speakers on again.',
            ];
        }

        $durationSec = $minutesDefault * 60;
        if ($songRemaining > 0 && $songRemaining > $durationSec) {
            $durationSec = $songRemaining;
        }

        if ($maxExtension > 0 && $durationSec > $maxExtension) {
            $durationSec = $maxExtension;
        }

        $offAt = $now + $durationSec;

        $state['speaker_on']  = true;
        $state['last_on_at']  = $now;
        $state['off_at']      = $offAt;

        self::save_state($state);

        // NOTE:
        // We are intentionally NOT yet calling FPP here so we don't break the existing working setup.
        // Later, we will wire this to POST to the FPP API to run speaker-amp-on.sh
        // and add a matching /speaker/off endpoint for speaker-amp-off.sh.

        return [
            'success'         => true,
            'message'         => 'Speaker timer started.',
            'offAt'           => $offAt,
            'durationSeconds' => $durationSec,
        ];
    }
}