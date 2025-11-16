<?php
/**
 * Plugin Name: Lights on Falcon Extras
 * Plugin URI: https://lightsonfalcon.com
 * Description: Viewer extras (Glow, Speaker, Fog, Tonight panel, and show brain integrations) for Lights on Falcon.
 * Version: 0.4.1
 * Author: Joe Hayden
 * Author URI: https://lightsonfalcon.com
 * Text Domain: lights-on-falcon-extras
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

// Main plugin bootstrap lives here.
// This keeps the historical plugin entry at lights-on-falcon-extras/lof-extras.php
// while letting us organize the real code in lights-on-falcon-extras.php.
require_once __DIR__ . '/lights-on-falcon-extras.php';
