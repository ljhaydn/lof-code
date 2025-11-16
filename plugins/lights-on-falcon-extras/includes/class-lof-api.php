<?php
/**
 * Lights On Falcon – Extras
 * Lightweight REST API for viewer integration.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! class_exists( 'LOF_API' ) ) {

	class LOF_API {

		/**
		 * Constructor.
		 */
		public function __construct() {
			add_action( 'rest_api_init', array( $this, 'register_routes' ) );
		}

		/**
		 * Register custom REST routes.
		 */
		public function register_routes() {
			register_rest_route(
				'lof-extras/v1',
				'/viewer-config',
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'get_viewer_config' ),
					'permission_callback' => '__return_true',
				)
			);

			// We can add more routes here later, e.g.:
			// - /presence/ping
			// - /presence/summary
			// - /glow
		}

		/**
		 * Build the viewer-config payload that rf-viewer.js consumes.
		 *
		 * @param WP_REST_Request $request
		 * @return WP_REST_Response
		 */
		public function get_viewer_config( $request ) {
			if ( ! class_exists( 'LOF_Settings' ) ) {
				// Fail soft – JS treats this as "no extras".
				return rest_ensure_response(
					array(
						'copy'     => array(),
						'features' => array(),
					)
				);
			}

			$defaults = LOF_Settings::get_copy_defaults();
			$options  = get_option( LOF_Settings::OPTION_KEY_COPY, array() );

			if ( ! is_array( $options ) ) {
				$options = array();
			}

			$copy = array_merge( $defaults, $options );

			$payload = array(
				'copy'     => $copy,
				'features' => array(
					// Hooks for Phase 2+ if you want to toggle stuff:
					// 'glow_enabled'      => true,
					// 'speaker_enabled'   => true,
					// 'presence_enabled'  => true,
				),
			);

			return rest_ensure_response( $payload );
		}
	}

	// Boot it.
	new LOF_API();
}