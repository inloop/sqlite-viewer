[![Android Arsenal](https://img.shields.io/badge/Android%20Arsenal-SQLite%20Viewer-brightgreen.svg?style=flat)](http://android-arsenal.com/details/1/2497)

SQLite Viewer
============

*View SQLite file online. Uses [sql.js](https://github.com/sql-js/sql.js) for parsing sqlite files.*

You can also load remote files (using JS ajax, remote server must send `Access-Control-Allow-Origin:*`):
`http://inloop.github.io/sqlite-viewer/?url=http://example.com/data.sqlite`

![](/img/preview.png?raw=true "Example sqlite")

## Quick Start

### Using Docker (Recommended)

```bash
# Clone and run with Docker Compose
git clone https://github.com/inloop/sqlite-viewer.git
cd sqlite-viewer
docker-compose up -d
```

Access at: `http://localhost:8080`

### Direct Usage

Simply open `index.html` in your browser or serve the files with any web server.

## Docker Support

This project includes full Docker support for easy deployment:

- **Production deployment** with optimized nginx configuration
- **Development mode** with live file mounting
- **Security headers** and performance optimizations included
- **Health checks** and proper error handling

See [DOCKER.md](DOCKER.md) for detailed Docker usage instructions.

### Quick Docker Commands

```bash
# Production mode
docker-compose up -d

# Development mode with live reload
docker-compose --profile development up -d

# Build and run manually
docker build -t sqlite-viewer .
docker run -d -p 8080:80 sqlite-viewer
```

## Features

- 🗄️ **Client-side SQLite viewing** - No file uploads, everything runs in your browser
- 🔍 **SQL query execution** - Run custom SQL queries with syntax highlighting
- 📊 **Table browsing** - Easy navigation between tables and views
- 📥 **CSV export** - Export tables and query results
- 🔗 **URL loading** - Load SQLite files from remote URLs
- 🐳 **Docker ready** - Production-ready containerized deployment
- 📱 **Responsive design** - Works on desktop and mobile devices

### License
    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at
    
    http://www.apache.org/licenses/LICENSE-2.0
    
    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
