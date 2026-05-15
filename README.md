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
- Kill a running PM2 app or stop a running Docker Compose app from the config list
- Session-based authentication with brute-force rate limiting

## Stack

- **Runtime:** Node.js + TypeScript
- **Backend:** Express
- **Database:** SQLite (better-sqlite3)
- **Frontend:** Vanilla JS + HTML/CSS

## Requirements

- Node.js v18+
- PM2 (`npm install -g pm2`) — required for the `pm2:` step in Node/Static modes
- Docker — required for Docker mode deployments

## Installation

### Linux (systemd service) — recommended

This method runs auto-deploy as a systemd service that starts automatically on boot and restarts on crashes. It supports all deployment modes (Node, Docker, and Static).

```bash
bash install-service.sh
```

The script will:
1. Install Node.js if not already installed
2. Install dependencies and build the project
3. Create and enable a systemd service
4. Start the service automatically

Make sure you have a `.env` file configured before running the installer (see [Configuration](#configuration)).

**Managing the service:**

```bash
sudo systemctl status auto-deploy    # Check service status
sudo systemctl stop auto-deploy      # Stop the service
sudo systemctl start auto-deploy     # Start the service
sudo systemctl restart auto-deploy   # Restart the service
sudo journalctl -u auto-deploy -f    # View live logs
```

### Docker

**Note:** Docker installation only supports Docker mode deployments. You cannot use Node or Static modes because PM2 commands cannot be executed on the host from inside the container.

Edit `docker-compose.yml` to set the host port, then:

```bash
docker compose up -d --build
```

The container uses the Docker CLI only. It communicates with the host Docker daemon via the socket mounted at `/var/run/docker.sock`. Project paths you configure must be host paths. The daemon resolves them on the host filesystem. The `./data` directory is mounted into the container so the database and config persist across restarts.

### Linux (bare metal)

Runs the server directly without systemd service management:

```bash
bash run-linux.sh
```

Installs Node.js if missing, builds the project, and starts the server. The server will stop when you close the terminal or press Ctrl+C.

### Manual

```bash
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

Each repo config includes a `steps` array that defines the commands to run on deploy. Steps are executed sequentially — if any step fails, the deploy stops and is marked as failed.

A step prefixed with `pm2:` is treated as a **PM2 step**. It must be last. After all preceding steps succeed, auto-deploy will delete any existing PM2 process for this repo and start a fresh one under the name `auto-deploy-<repo-name>`. The process list is then saved with `pm2 save` so it survives a server reboot (see [PM2 setup](#pm2-setup) below).

### Node deploy example

```
git pull
npm ci
npm run build
pm2: npm run start
```

### Docker deploy example

```
git pull
docker compose pull
docker compose up -d --build
```

### Static site deploy example

```
git pull
npx serve -l 3000
```

### Allowed steps

Only the following commands are accepted to prevent arbitrary code execution:

#### Node
| Step | Optional Flags |
|---|---|
| `git pull` | `--rebase`, `--force` |
| `npm install` | Can use `npm ci` instead |
| `npm run build` | Optional |
| `pm2: npm run start` | |

#### Docker
| Step | Optional Flags |
|---|---|
| `docker compose pull` | |
| `docker compose down` | |
| `docker compose up -d --build` | |

#### Static
| Step | Optional Flags |
|---|---|
| `git pull` | `--rebase`, `--force` |
| `npx serve -l <port>` | |

## PM2 Setup (Required for node/static modes)

PM2 must be installed globally on the server before using the `pm2:` step:

```
npm install -g pm2
```

To have PM2 restore your apps automatically after a server reboot, run this once over SSH as your deploy user:

```
pm2 startup
```

This prints a `sudo` command, copy and run it. You only need to do this once per server. From then on, `pm2 save` (which auto-deploy runs after every successful deploy) will keep the process list up to date with no further root access required.

If you skip `pm2 startup`, apps will still be managed by PM2 and will auto-restart on crashes. They just won't come back after a full server reboot.

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
| `POST` | `/app/stop/:name` | Kill a repo's PM2 process |
| `POST` | `/app/docker-stop/:name` | Run `docker compose down` for a repo |
| `POST` | `/config` | Create or update a repo config |
| `DELETE` | `/config/:name` | Delete a repo config |
| `GET` | `/configs` | List all repo configs |
| `GET` | `/logs/stream/:deployId` | SSE stream of deploy logs |

## License

See [MIT](./LICENSE).
