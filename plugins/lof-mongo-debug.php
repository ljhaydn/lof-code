<?php
require_once '/var/www/wordpress/vendor/autoload.php';

echo "=== LOF Mongo Debug ===\n\n";

$connection_string = 'mongodb://root:root@10.9.6.63:27017/?authSource=admin';

try {
    $client = new MongoDB\Client($connection_string);
    $collection = $client->selectCollection('remote-falcon', 'show');
    echo "Connected OK\n\n";
    
    // Check jukebox structure
    $show = $collection->findOne();
    $jukebox = $show['stats']['jukebox'] ?? [];
    echo "Jukebox entries: " . count($jukebox) . "\n\n";
    
    if (count($jukebox) > 0) {
        echo "First entry:\n";
        $first = json_decode(json_encode($jukebox[0]), true);
        print_r($first);
        
        echo "\n\nLast entry:\n";
        $last = json_decode(json_encode($jukebox[count($jukebox)-1]), true);
        print_r($last);
    }
    
} catch (Exception $e) {
    echo "Error: " . $e->getMessage() . "\n";
}
