<?php
/*
Plugin Name: Lights On Falcon - Extras
Description: Core logic, APIs, settings, and viewer enhancements for the Lights On Falcon experience.
Version: 1.0.0
Author: Lights on Falcon
*/

if (!defined('ABSPATH')) exit;

// Autoload includes
require_once plugin_dir_path(__FILE__) . 'includes/class-lof-settings.php';
require_once plugin_dir_path(__FILE__) . 'includes/class-lof-api.php';
require_once plugin_dir_path(__FILE__) . 'includes/class-lof-speaker.php';
require_once plugin_dir_path(__FILE__) . 'includes/class-lof-glow.php';

// Init plugin
add_action('plugins_loaded', function() {
    LOF_Settings::init();
    LOF_API::init();
    LOF_Speaker::init();
    LOF_Glow::init();
});