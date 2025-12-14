<?php
/*
Plugin Name: Lights On Falcon - Extras
Description: Core logic, APIs, settings, and viewer enhancements for the the Lights on Falcon experience.
Version: 1.5.1
Author: Lights on Falcon
*/

if (!defined('ABSPATH')) {
    exit;
}

/**
 * V1.5.1: Load Composer autoloader BEFORE checking for MongoDB\Client
 * 
 * The autoloader is typically in the WordPress root's vendor/ directory.
 * We check multiple possible locations.
 */
$autoloader_paths = [
    ABSPATH . 'vendor/autoload.php',                    // /var/www/wordpress/vendor/autoload.php
    ABSPATH . 'wp-content/vendor/autoload.php',         // Alternative location
    dirname(__FILE__) . '/vendor/autoload.php',         // Plugin-local (if composer ran here)
    WP_CONTENT_DIR . '/vendor/autoload.php',            // wp-content/vendor/
];

$composer_autoloader_loaded = false;
foreach ($autoloader_paths as $autoloader_path) {
    if (file_exists($autoloader_path)) {
        require_once $autoloader_path;
        $composer_autoloader_loaded = true;
        break;
    }
}

if (!$composer_autoloader_loaded) {
    // Log warning but don't break - MongoDB features just won't work
    error_log('[LOF Extras] Composer autoloader not found. MongoDB features disabled. Run: cd ' . ABSPATH . ' && composer require mongodb/mongodb');
}

// Includes
require_once plugin_dir_path(__FILE__) . 'includes/class-lof-settings.php';
require_once plugin_dir_path(__FILE__) . 'includes/class-lof-api.php';
require_once plugin_dir_path(__FILE__) . 'includes/class-lof-speaker.php';
require_once plugin_dir_path(__FILE__) . 'includes/class-lof-glow.php';

// V1.5: MongoDB integration for RF data (song stats, leaderboards)
// NOW the class_exists check will work because autoloader was loaded above
$mongodb_available = extension_loaded('mongodb') && class_exists('MongoDB\Client');

if ($mongodb_available) {
    $mongo_class = plugin_dir_path(__FILE__) . 'includes/class-lof-mongo.php';
    if (file_exists($mongo_class)) {
        require_once $mongo_class;
        error_log('[LOF Extras] MongoDB integration loaded successfully');
    }
} else {
    if (!extension_loaded('mongodb')) {
        error_log('[LOF Extras] MongoDB PHP extension not installed. Run: sudo apt install php-mongodb');
    } elseif (!class_exists('MongoDB\Client')) {
        error_log('[LOF Extras] MongoDB library not found. Run: cd ' . ABSPATH . ' && composer require mongodb/mongodb');
    }
}

require_once plugin_dir_path(__FILE__) . 'includes/class-lof-viewer-trigger-api.php';
require_once plugin_dir_path(__FILE__) . 'includes/class-lof-viewer-state.php';

// Bootstrap
add_action('plugins_loaded', function () {
    LOF_Settings::init();
    LOF_API::init();
    LOF_Speaker::init();
    LOF_Glow::init();
    LOF_Viewer_State::init();
});
