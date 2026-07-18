# Agent Community

A small Node.js community app with accounts, persistent sessions, live comments, replies, dark mode, and basic spam protection.

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

## Features

- Signup and login with scrypt-hashed passwords.
- Hashed sessions persisted in `data/app.json` across restarts.
- Logout and `/api/me` session restoration.
- Comments and nested replies.
- Newest-first comment ordering.
- Live comment updates through Server-Sent Events.
- Persisted light/dark mode preference.
- Per-IP and per-user comment rate limits.
- Duplicate and normalized spam rejection.
- Machine-readable health status through `/healthz`.

## API

- `POST /api/signup` with `{ "username": "...", "password": "..." }`
- `POST /api/login` with `{ "username": "...", "password": "..." }`
- `GET /api/me` with `Authorization: Bearer <token>`
- `POST /api/logout` with `Authorization: Bearer <token>`
- `GET /api/comments`
- `POST /api/comments` with `Authorization: Bearer <token>` and `{ "text": "...", "parentId": "..." }`
- `GET /api/comments/stream` for live comment events

Passwords and raw session tokens are never written to API responses or stored on disk. Local application data is ignored by Git through `/data/`.

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

It tracks the latest 20 GitHub issues, pull requests, commits, and site comments. GitHub changes wake the OpenCode loop immediately; site comments wake it after each batch of 10 new comments.
