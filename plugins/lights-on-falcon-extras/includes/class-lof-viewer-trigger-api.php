<?php
// Simple REST API for trigger counts (button/mailbox/etc).
// V1.5: Normalized trigger count keys for JavaScript consistency

add_action( 'rest_api_init', function () {
    register_rest_route(
        'lof-viewer/v1',
        '/trigger-hit',
        array(
            'methods'             => 'POST',
            'callback'            => 'lof_viewer_trigger_hit',
            'permission_callback' => '__return_true', // we'll gate with token
        )
    );

    register_rest_route(
        'lof-viewer/v1',
        '/trigger-counts',
        array(
            'methods'             => 'GET',
            'callback'            => 'lof_viewer_get_trigger_counts',
            'permission_callback' => '__return_true',
        )
    );
} );

/**
 * POST /wp-json/lof-viewer/v1/trigger-hit
 *
 * Body JSON: { "trigger_key": "mailbox", "playlist": "Mailbox Trigger", "total": 42 }
 * Header: X-LOF-Trigger-Token: super-secret-token
 */
function lof_viewer_trigger_hit( WP_REST_Request $request ) {
    $shared_secret = 'santasmailbox'; // MUST match FPP script

    $header_token = $request->get_header( 'x-lof-trigger-token' );
    if ( $header_token !== $shared_secret ) {
        return new WP_REST_Response( array( 'error' => 'unauthorized' ), 403 );
    }

    $body = json_decode( $request->get_body(), true );
    if ( ! is_array( $body ) ) {
        return new WP_REST_Response( array( 'error' => 'invalid_json' ), 400 );
    }

    $trigger_key = isset( $body['trigger_key'] ) ? sanitize_key( $body['trigger_key'] ) : '';
    $total       = isset( $body['total'] ) ? intval( $body['total'] ) : null;

    if ( ! $trigger_key ) {
        return new WP_REST_Response( array( 'error' => 'missing trigger_key' ), 400 );
    }

    $counts = get_option( 'lof_viewer_trigger_counts', array() );
    if ( ! is_array( $counts ) ) {
        $counts = array();
    }

    if ( null !== $total ) {
        // FPP is source of truth: set to the total it reports
        $counts[ $trigger_key ] = $total;
    } else {
        // Fallback (shouldn't really happen once scripts are updated)
        if ( ! isset( $counts[ $trigger_key ] ) ) {
            $counts[ $trigger_key ] = 0;
        }
        $counts[ $trigger_key ]++;
    }

    update_option( 'lof_viewer_trigger_counts', $counts );

    return new WP_REST_Response(
        array(
            'success'     => true,
            'trigger_key' => $trigger_key,
            'count'       => $counts[ $trigger_key ],
        ),
        200
    );
}

/**
 * GET /wp-json/lof-viewer/v1/trigger-counts
 *
 * Returns: { "success": true, "counts": { "santaMailbox": 12, "buttonPress": 5 } }
 *
 * V1.5: Normalized keys for JavaScript consistency
 * - FPP scripts send keys like 'mailbox' and 'button'
 * - JavaScript expects camelCase: 'santaMailbox' and 'buttonPress'
 * - This function normalizes the keys for consistent frontend usage
 */
function lof_viewer_get_trigger_counts( WP_REST_Request $request ) {
    $counts = get_option( 'lof_viewer_trigger_counts', array() );
    if ( ! is_array( $counts ) ) {
        $counts = array();
    }

    // V1.5: Normalize keys for JavaScript
    // Map FPP script keys to JavaScript-expected camelCase keys
    $normalized = array(
        'santaMailbox' => isset( $counts['mailbox'] ) ? (int) $counts['mailbox'] : 0,
        'buttonPress'  => isset( $counts['button'] ) ? (int) $counts['button'] : 0,
    );

    return new WP_REST_Response(
        array(
            'success' => true,
            'counts'  => $normalized,
        ),
        200
    );
}