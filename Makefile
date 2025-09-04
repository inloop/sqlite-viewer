# SQLite Viewer - Docker Management
.PHONY: help build run dev stop clean logs shell test

# Default target
help: ## Show this help message
	@echo "SQLite Viewer - Docker Management"
	@echo "================================="
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# Build the Docker image
build: ## Build the Docker image
	@echo "Building SQLite Viewer Docker image..."
	docker build -t sqlite-viewer .

# Run in production mode
run: ## Run the application in production mode (port 8080)
	@echo "Starting SQLite Viewer in production mode..."
	docker-compose up -d
	@echo "SQLite Viewer is running at http://localhost:8080"

# Run in development mode
dev: ## Run the application in development mode (port 3000)
	@echo "Starting SQLite Viewer in development mode..."
	docker-compose --profile development up -d
	@echo "SQLite Viewer (dev) is running at http://localhost:3000"

# Stop all services
stop: ## Stop all running services
	@echo "Stopping SQLite Viewer services..."
	docker-compose down

# Stop and remove all containers, networks, and volumes
clean: ## Clean up all containers, networks, and volumes
	@echo "Cleaning up SQLite Viewer resources..."
	docker-compose down -v --remove-orphans
	docker system prune -f

# Show logs
logs: ## Show logs from running containers
	docker-compose logs -f

# Show development logs
logs-dev: ## Show logs from development container
	docker-compose logs -f sqlite-viewer-dev

# Open shell in running container
shell: ## Open shell in the running production container
	docker exec -it sqlite-viewer sh

# Open shell in development container
shell-dev: ## Open shell in the running development container
	docker exec -it sqlite-viewer-dev sh

# Restart services
restart: ## Restart all services
	@echo "Restarting SQLite Viewer services..."
	docker-compose restart

# Update and rebuild
update: ## Update and rebuild the application
	@echo "Updating SQLite Viewer..."
	docker-compose down
	docker-compose build --no-cache
	docker-compose up -d
	@echo "SQLite Viewer updated and running at http://localhost:8080"

# Run health check
health: ## Check the health status of containers
	@echo "Container health status:"
	@docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Show resource usage
stats: ## Show container resource usage
	docker stats --no-stream

# Test the application
test: ## Test if the application is responding
	@echo "Testing SQLite Viewer..."
	@curl -f http://localhost:8080 >/dev/null 2>&1 && echo "✅ Production service is healthy" || echo "❌ Production service is not responding"
	@curl -f http://localhost:3000 >/dev/null 2>&1 && echo "✅ Development service is healthy" || echo "⚠️  Development service is not running"

# Quick development setup
setup: build run ## Build and run the application
	@echo "SQLite Viewer setup complete!"
	@echo "Production: http://localhost:8080"
	@echo "To start development mode: make dev"

# Deploy to production
deploy: ## Deploy to production (build and run optimized)
	@echo "Deploying SQLite Viewer to production..."
	docker-compose down
	docker-compose build --no-cache
	docker-compose up -d
	@echo "Production deployment complete!"
	@echo "Application available at: http://localhost:8080"

# Backup examples directory
backup: ## Backup the examples directory
	@echo "Creating backup of examples directory..."
	@tar -czf backup-examples-$(shell date +%Y%m%d-%H%M%S).tar.gz examples/
	@echo "Backup created successfully"

# Show help by default
.DEFAULT_GOAL := help
