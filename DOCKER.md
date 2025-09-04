# Docker Usage for SQLite Viewer

This document provides instructions for running SQLite Viewer using Docker.

## Quick Start

### Using Docker Compose (Recommended)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/inloop/sqlite-viewer.git
   cd sqlite-viewer
   ```

2. **Run with Docker Compose:**
   ```bash
   docker-compose up -d
   ```

3. **Access the application:**
   Open your browser and navigate to: `http://localhost:8080`

### Using Docker directly

1. **Build the image:**
   ```bash
   docker build -t sqlite-viewer .
   ```

2. **Run the container:**
   ```bash
   docker run -d -p 8080:80 --name sqlite-viewer sqlite-viewer
   ```

3. **Access the application:**
   Open your browser and navigate to: `http://localhost:8080`

## Development Mode

For development with live file mounting:

```bash
docker-compose --profile development up -d sqlite-viewer-dev
```

This will:
- Mount your local files into the container
- Enable live reload for development
- Run on port 3000: `http://localhost:3000`

## Configuration Options

### Environment Variables

- `NGINX_HOST`: Set the nginx host (default: localhost)
- `NGINX_PORT`: Set the nginx port (default: 80)

### Volume Mounts

You can mount SQLite files to share with the container:

```bash
docker run -d -p 8080:80 \
  -v /path/to/your/sqlite/files:/usr/share/nginx/html/examples:ro \
  --name sqlite-viewer sqlite-viewer
```

### Custom nginx Configuration

To use a custom nginx configuration:

```bash
docker run -d -p 8080:80 \
  -v /path/to/your/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
  --name sqlite-viewer sqlite-viewer
```

## Docker Compose Services

### Production Service (`sqlite-viewer`)
- **Port**: 8080
- **Purpose**: Production-ready deployment
- **Features**: Optimized nginx configuration, caching, security headers

### Development Service (`sqlite-viewer-dev`)
- **Port**: 3000
- **Purpose**: Development with live file mounting
- **Features**: Live reload, source code mounting
- **Activation**: Use `--profile development` flag

## Useful Commands

### Management Commands

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# View logs
docker-compose logs -f sqlite-viewer

# Restart services
docker-compose restart

# Update and rebuild
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Development Commands

```bash
# Start development mode
docker-compose --profile development up -d

# View development logs
docker-compose logs -f sqlite-viewer-dev

# Shell into container
docker exec -it sqlite-viewer sh
```

### Maintenance Commands

```bash
# Remove stopped containers
docker container prune

# Remove unused images
docker image prune

# Remove everything (be careful!)
docker system prune -a
```

## Networking

### Traefik Integration

The docker-compose.yml includes Traefik labels for easy reverse proxy setup:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.sqlite-viewer.rule=Host(`sqlite-viewer.localhost`)"
  - "traefik.http.services.sqlite-viewer.loadbalancer.server.port=80"
```

### Custom Network

A dedicated bridge network `sqlite-viewer-network` is created for service isolation.

## Security Features

The nginx configuration includes:
- **Security headers**: X-Frame-Options, X-Content-Type-Options, X-XSS-Protection
- **CORS headers**: Proper handling for WebAssembly files
- **Content-Type enforcement**: Proper MIME types for all file types
- **Access restrictions**: Hidden files are blocked

## Performance Optimizations

- **Gzip compression**: Enabled for text files
- **Static asset caching**: 1-year cache for immutable assets
- **WebAssembly support**: Proper MIME type and caching for .wasm files
- **Alpine Linux**: Minimal base image for smaller size

## Health Checks

The container includes a health check that:
- Runs every 30 seconds
- Has a 3-second timeout
- Allows 5 seconds for startup
- Retries 3 times before marking as unhealthy

Check container health:
```bash
docker ps
# Look for "(healthy)" status
```

## Troubleshooting

### Common Issues

1. **Port already in use:**
   ```bash
   # Change the port mapping
   docker-compose down
   # Edit docker-compose.yml to use different port
   docker-compose up -d
   ```

2. **Permission issues:**
   ```bash
   # Ensure proper file permissions
   chmod -R 644 .
   chmod 755 . css js img examples
   ```

3. **WebAssembly not loading:**
   - Ensure CORS headers are properly set
   - Check browser console for errors
   - Verify .wasm files are accessible

4. **Container won't start:**
   ```bash
   # Check logs
   docker-compose logs sqlite-viewer
   
   # Rebuild without cache
   docker-compose build --no-cache
   ```

### Debug Mode

Run container in interactive mode for debugging:
```bash
docker run -it --rm -p 8080:80 sqlite-viewer sh
```

## Deployment Examples

### Production Deployment

```bash
# Production with custom domain
docker run -d \
  --name sqlite-viewer-prod \
  -p 80:80 \
  -v /opt/sqlite-files:/usr/share/nginx/html/examples:ro \
  --restart unless-stopped \
  sqlite-viewer
```

### Behind Reverse Proxy

```bash
# For use with nginx/Apache reverse proxy
docker run -d \
  --name sqlite-viewer \
  -p 127.0.0.1:8080:80 \
  --restart unless-stopped \
  sqlite-viewer
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sqlite-viewer
spec:
  replicas: 2
  selector:
    matchLabels:
      app: sqlite-viewer
  template:
    metadata:
      labels:
        app: sqlite-viewer
    spec:
      containers:
      - name: sqlite-viewer
        image: sqlite-viewer:latest
        ports:
        - containerPort: 80
        resources:
          requests:
            memory: "64Mi"
            cpu: "50m"
          limits:
            memory: "128Mi"
            cpu: "100m"
```
