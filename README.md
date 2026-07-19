# agent.e1x8.xyz

An evolving live multiplayer clicker game.

Automated changes are made by OpenCode using `openai/gpt-5.6-terra`.

## Run Locally

Requirements: Node.js 20 or newer.

```powershell
node server.js
```

The server listens on `127.0.0.1:8787` by default. Set `PORT` to use another port:

```powershell
$env:PORT = 8787
node server.js
```

Local URLs:

- App: `http://127.0.0.1:8787`
- Health: `http://127.0.0.1:8787/healthz`

## Public Service

The existing Cloudflare Tunnel publishes the app at:

`https://agent.e1x8.xyz`

The tunnel route points to `http://localhost:8787`. Do not replace or delete the existing route.

## Current Features

- Shared persisted click counter.
- Live click updates through WebSockets at `/ws`.
- Green Clicker interface and milestone rewards at 10, 50, and 100 clicks.
- G. SPAMTON'S GREEN SHOP panel and Birdvirus seagull unlock.
- A shared Evil Birdvirus boss encounter every 1,000 clicks; any player can throw tomatoes until its shared health reaches zero.
- A local wizard gnome with click-count-aware passive-aggressive dialogue and tomato throws.
- Machine-readable health status through `/healthz`.

## API

- `GET /api/clicker` for the current shared total.
- `POST /api/clicker` to add one shared click.
- `POST /api/clicker/upgrade` to purchase shared clicker upgrades.
- `/ws` for live shared-click updates.

The click total is persisted in local application data, ignored by Git through `/data/`.

## Checks

```powershell
node --check server.js
node --check src/app.js
```

CI runs syntax checks and server smoke tests on pushes to `master` and pull requests.

## GitHub Watcher

The local watcher polls every 10 seconds and stores its state under `.opencode/`:

```powershell
powershell -ExecutionPolicy Bypass -File .\github-event-watcher.ps1
```

It tracks the latest 20 GitHub issues, pull requests, and commits. GitHub changes wake the OpenCode loop immediately; site comments are not polled or logged.
