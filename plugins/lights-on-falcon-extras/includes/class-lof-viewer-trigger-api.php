<?php
// Simple REST API for trigger counts (button/mailbox/etc).

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

    register_rest_route(
        'lof-viewer/v1',
        '/surprise-me',
        array(
            'methods'             => array( 'GET', 'POST' ),
            'callback'            => 'lof_viewer_surprise_me',
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
 * Returns: { "success": true, "counts": { "button": 12, "mailbox": 5 } }
 */
function lof_viewer_get_trigger_counts( WP_REST_Request $request ) {
    $counts = get_option( 'lof_viewer_trigger_counts', array() );
    if ( ! is_array( $counts ) ) {
        $counts = array();
    }

    return new WP_REST_Response(
        array(
            'success' => true,
            'counts'  => $counts,
        ),
        200
    );
}

/**
 * GET/POST /wp-json/lof-viewer/v1/surprise-me
 *
 * Selects a random eligible sequence from Remote Falcon's show details
 * and queues it via the rf/v1/request proxy. This endpoint is used by
 * both the on-page "Surprise me" control and the physical button script.
 */
function lof_viewer_surprise_me( WP_REST_Request $request ) {
    // 1) Fetch current show details from the RF proxy
    $show_url = rest_url( 'rf/v1/show-details' );

    $show_resp = wp_remote_get(
        $show_url,
        array(
            'timeout' => 10,
            'headers' => array(
                'Accept' => 'application/json',
            ),
        )
    );

    if ( is_wp_error( $show_resp ) ) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'Unable to reach show details proxy.',
            ),
            500
        );
    }

    $show_code = wp_remote_retrieve_response_code( $show_resp );
    $show_body = wp_remote_retrieve_body( $show_resp );
    $show_json = json_decode( $show_body, true );

    if ( 200 !== $show_code || ! is_array( $show_json ) ) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'Unexpected response from show details proxy.',
            ),
            500
        );
    }

    // The rf/v1/show-details proxy returns:
    // { "status": 200, "data": { ...Remote Falcon showDetails payload... } }
    $core = ( isset( $show_json['data'] ) && is_array( $show_json['data'] ) )
        ? $show_json['data']
        : $show_json;

    $sequences = array();
    if ( isset( $core['sequences'] ) && is_array( $core['sequences'] ) ) {
        $sequences = $core['sequences'];
    }

    if ( empty( $sequences ) ) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'No sequences available for Surprise Me.',
            ),
            500
        );
    }

    $playing_now_raw  = isset( $core['playingNow'] ) ? (string) $core['playingNow'] : '';
    $playing_next_raw = isset( $core['playingNext'] ) ? (string) $core['playingNext'] : '';

    // 2) Build a candidate pool, preferring visible/active items and
    // excluding the currently playing + next up where possible.
    $candidates = array();

    foreach ( $sequences as $seq ) {
        if ( ! is_array( $seq ) ) {
            continue;
        }

        $name         = isset( $seq['name'] ) ? (string) $seq['name'] : '';
        $display_name = isset( $seq['displayName'] ) ? (string) $seq['displayName'] : '';

        if ( '' === $name && '' === $display_name ) {
            continue;
        }

        // Respect visibility/active flags when present
        if ( isset( $seq['visible'] ) && ! $seq['visible'] ) {
            continue;
        }
        if ( isset( $seq['active'] ) && ! $seq['active'] ) {
            continue;
        }

        // Avoid the song that is currently playing or explicitly marked next
        if (
            $playing_now_raw &&
            ( $name === $playing_now_raw || $display_name === $playing_now_raw )
        ) {
            continue;
        }
        if (
            $playing_next_raw &&
            ( $name === $playing_next_raw || $display_name === $playing_next_raw )
        ) {
            continue;
        }

        $candidates[] = $seq;
    }

    if ( empty( $candidates ) ) {
        // Fall back to full list if our filtered pool ends up empty
        $candidates = $sequences;
    }

    // 3) Light variety guardrail: avoid the last few Surprise Me picks
    $recent_key   = 'lof_viewer_surprise_recent';
    $recent_names = get_transient( $recent_key );
    if ( ! is_array( $recent_names ) ) {
        $recent_names = array();
    }

    $pool = array();

    foreach ( $candidates as $seq ) {
        if ( ! is_array( $seq ) ) {
            continue;
        }
        $name = isset( $seq['name'] ) ? (string) $seq['name'] : '';
        if ( '' === $name ) {
            continue;
        }

        if ( ! in_array( $name, $recent_names, true ) ) {
            $pool[] = $seq;
        }
    }

    if ( empty( $pool ) ) {
        $pool = $candidates;
    }

    // Safety: still nothing usable
    if ( empty( $pool ) ) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'No eligible sequences found for Surprise Me.',
            ),
            500
        );
    }

    // 4) Pick one at random
    $index        = array_rand( $pool );
    $chosen       = $pool[ $index ];
    $chosen_name  = isset( $chosen['name'] ) ? (string) $chosen['name'] : '';
    $chosen_label = isset( $chosen['displayName'] ) ? (string) $chosen['displayName'] : $chosen_name;

    if ( '' === $chosen_name ) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'Chosen sequence did not have a valid internal name.',
            ),
            500
        );
    }

    // Update recent picks (keep the last 5 entries)
    array_unshift( $recent_names, $chosen_name );
    $recent_names = array_values( array_unique( $recent_names ) );
    $recent_names = array_slice( $recent_names, 0, 5 );
    set_transient( $recent_key, $recent_names, 12 * HOUR_IN_SECONDS );

    // 5) Queue via the rf/v1/request proxy
    $request_url = rest_url( 'rf/v1/request' );
    $body        = array(
        'sequence' => $chosen_name,
    );

    $rf_resp = wp_remote_post(
        $request_url,
        array(
            'timeout' => 10,
            'headers' => array(
                'Content-Type' => 'application/json',
                'Accept'       => 'application/json',
            ),
            'body'    => wp_json_encode( $body ),
        )
    );

    if ( is_wp_error( $rf_resp ) ) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'Unable to queue Surprise Me request.',
            ),
            500
        );
    }

    $rf_code = wp_remote_retrieve_response_code( $rf_resp );
    $rf_body = wp_remote_retrieve_body( $rf_resp );
    $rf_json = json_decode( $rf_body, true );

    if ( $rf_code < 200 || $rf_code >= 300 ) {
        return new WP_REST_Response(
            array(
                'success' => false,
                'message' => 'Remote Falcon did not accept the Surprise Me request.',
                'rf'      => array(
                    'status' => $rf_code,
                ),
            ),
            500
        );
    }

    return new WP_REST_Response(
        array(
            'success'  => true,
            'message'  => sprintf(
                'Queued a surprise track: %s',
                $chosen_label ? $chosen_label : $chosen_name
            ),
            'sequence' => array(
                'name'        => $chosen_name,
                'displayName' => $chosen_label,
            ),
            'rf'       => array(
                'status' => $rf_code,
                'raw'    => $rf_json,
            ),
        ),
        200
    );
}