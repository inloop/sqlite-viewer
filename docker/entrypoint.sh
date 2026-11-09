#!/bin/sh
set -e

echo "=== SQLite Viewer Container Booting ==="

# 1. Check if database volume is mounted at the standard locations
if [ -f "/var/www/data.zip" ]; then
    echo "-> Detected mounted SQLite database ZIP at /var/www/data.zip"
    if [ -z "$DEFAULT_URL" ]; then
        # Default URL to the mapped Nginx route
        DEFAULT_URL="data.zip"
        echo "-> Automatically setting DEFAULT_URL to: data.zip"
    fi
elif [ -f "/var/www/data.sqlite" ]; then
    echo "-> Detected mounted SQLite database at /var/www/data.sqlite"
    if [ -z "$DEFAULT_URL" ]; then
        # Default URL to the mapped Nginx route
        DEFAULT_URL="data.sqlite"
        echo "-> Automatically setting DEFAULT_URL to: data.sqlite"
    fi
fi

# 2. Escape backslashes and single quotes in SQL to prevent breaking JS syntax
ESCAPED_SQL=$(echo "$DEFAULT_SQL" | sed 's/\\/\\\\/g' | sed "s/'/\\\\\\'/g")

echo "-> Generating client-side configuration..."
echo "   DEFAULT_URL: ${DEFAULT_URL:-none}"
echo "   DEFAULT_SQL: ${DEFAULT_SQL:-none}"

# 3. Write dynamic config to the webserver directory
cat << EOF > /usr/share/nginx/html/js/config.js
// Client-side application configuration
// Generated dynamically at container boot.
window.APP_CONFIG = {
    defaultUrl: "${DEFAULT_URL}",
    defaultSql: '${ESCAPED_SQL}'
};
EOF

echo "=== Starting Nginx Web Server ==="
exec nginx -g 'daemon off;'
