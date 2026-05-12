# Auto-Deploy

A webhook-driven deployment server. Receives GitHub push events, verifies the HMAC signature, and runs a configured sequence of deployment steps in the target project directory. Deploy history and logs are stored in SQLite and streamed live to the browser.

## Features

- GitHub webhook listener with HMAC-SHA256 signature verification
- Per-repo branch filtering - only deploys on the configured branch
- Per-repo deploy queue - incoming webhooks are queued if a deploy is already running
- Step-based deployment pipeline - each repo defines its own ordered list of commands
- Manual trigger from the dashboard
- Live log streaming over SSE
- Full deploy history with status tracking (pending, running, success, failed, stopped)
- Stop a running deploy from the UI
- Session-based authentication with brute-force rate limiting

## Stack

- **Runtime:** Node.js + TypeScript
- **Backend:** Express
- **Database:** SQLite (better-sqlite3)
- **Frontend:** Vanilla JS + HTML/CSS

## Requirements

- Node.js v18+
- Docker (optional)

## Installation

### Docker (recommended)

Edit `docker-compose.yml` to set the host port, then:

```
docker compose up -d --build
```

The container uses the Docker CLI only. It communicates with the host Docker daemon via the socket mounted at `/var/run/docker.sock`. Project paths you configure must be host paths - the daemon resolves them on the host filesystem. The `./data` directory is mounted into the container so the database and config persist across restarts.

### Linux (bare metal)

```
bash run-linux.sh
```

Installs Node.js if missing, builds the project, and starts the server.

### Manual

```
npm install
npm run build
npm start
```

## Configuration

Create a `.env` file in the project root:

```
PORT=3000
MASTER_KEY=your-secret-key-here
NODE_ENV=production
```

| Variable | Description | Default |
|---|---|---|
| `PORT` | Port the server listens on | `3000` |
| `MASTER_KEY` | Password for the admin panel | `admin` |
| `NODE_ENV` | Set to `production` to enable secure cookies | - |

`MASTER_KEY` must be at least 16 characters. The server will refuse to start without it.

## Deployment Pipeline

Each repo config includes a `steps` array that defines the commands to run on deploy. Steps are executed sequentially - if any step fails, the deploy stops and is marked as failed.

A step prefixed with `&` is treated as a **background step**. It is launched as a detached process after all foreground steps succeed. Only one background step is allowed per config and it must be last.

Before a new deploy starts, any background process from a previous deploy of the same repo is killed.

### Node deploy example

```
git pull
npm install
npm run build
& npm run start
```

### Docker deploy example

```
git pull
docker compose up -d --build
```

### Allowed steps

Only the following commands are accepted to prevent arbitrary code execution:

| Step | Notes |
|---|---|
| `git pull` | Optional `--rebase` or `--force` flag |
| `npm install` | |
| `npm ci` | |
| `npm run build` | |
| `docker compose pull` | |
| `docker compose down` | |
| `docker compose up -d --build` | Optional `--no-cache` flag |
| `& npm run start` | Background step - must be last |

## GitHub Webhook Setup

1. Log in to the dashboard and create a config for your repo (name, secret, local path, branch, and steps).
2. In your GitHub repo, go to **Settings > Webhooks > Add webhook**.
3. Set the payload URL to `http://your-server/webhook/<repo-name>`.
4. Set the content type to `application/json`.
5. Enter the same secret you configured in the dashboard.
6. Select the **push** event.

On every push to the configured branch, GitHub will call the webhook and a deploy will be queued.

## Pages

| Path | Description |
|---|---|
| `/` | Dashboard - deploy history, live logs, manual trigger |
| `/login` | Admin login |

## API

All endpoints require a valid session cookie except `/webhook/:repo` (which has its own middleware).

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhook/:repo` | GitHub webhook receiver |
| `GET` | `/deploy` | All deploys |
| `GET` | `/deploy/:name` | Deploys for a specific repo |
| `GET` | `/deploy/id/:id` | Single deploy by ID |
| `POST` | `/deploy/:name` | Manually trigger a deploy |
| `POST` | `/deploy/stop/:deployId` | Stop a running deploy |
| `POST` | `/config` | Create or update a repo config |
| `DELETE` | `/config/:name` | Delete a repo config |
| `GET` | `/configs` | List all repo configs |
| `GET` | `/logs/stream/:deployId` | SSE stream of deploy logs |

## License

See [MIT](./LICENSE).
