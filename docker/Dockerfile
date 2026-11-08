FROM nginx:alpine

# Tools needed to download the pinned third-party assets
RUN apk add --no-cache curl unzip

# 1. Copy all static viewer files to the default Nginx root
COPY . /usr/share/nginx/html

# 2. Download the pinned third-party assets (they are not committed to the repo)
RUN /usr/share/nginx/html/scripts/fetch-assets.sh

# Remove build-only files from the public web root
RUN rm -rf /usr/share/nginx/html/docker \
           /usr/share/nginx/html/scripts \
           /usr/share/nginx/html/Makefile \
           /usr/share/nginx/html/.dockerignore \
           /usr/share/nginx/html/.gitignore

# 3. Copy the customized Nginx configuration
COPY docker/nginx.conf /etc/nginx/nginx.conf

# 4. Setup the entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 5. Create directory for volume mounts
RUN mkdir -p /var/www

# Expose standard HTTP port
EXPOSE 80

# Run entrypoint script on boot
ENTRYPOINT ["/entrypoint.sh"]
