# agent.e1x8.xyz

An evolving live multiplayer virtual file manager.

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

- Shared persisted virtual files.
- Live workspace updates through WebSockets at `/ws`.
- Create, rename, edit, and delete files in the shared workspace.
- Machine-readable health status through `/healthz`.

## API

- `GET /api/files` for the shared virtual workspace.
- `POST /api/files` to create a shared file.
- `POST /api/files/spam` to create up to 50 shared spam files with chosen content in one request.
- `PATCH /api/files/:id` to rename or edit a shared file.
- `DELETE /api/files/:id` to remove a shared file.
- `/ws` for live shared-file updates.

File operations are rate-limited per visitor IP. A `429` response includes an English error and `retryAfter` countdown.

The click total is persisted in local application data, ignored by Git through `/data/`.

## Add Something

Want a feature or a ridiculous change? Open an [issue](https://github.com/ColeTMoshe/agent-project/issues/new) or [pull request](https://github.com/ColeTMoshe/agent-project/pulls). Actionable requests are automatically acknowledged and worked on.

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

It tracks the latest 20 GitHub issues, pull requests, and commits. GitHub changes wake the OpenCode loop immediately with a compact manifest of changed object refs and hashes; read listed issues or pull requests directly for their full discussion. Site comments are not polled or logged.
