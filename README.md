# Influence Hub — self-hosted prototype

Zero-dependency Node.js backend (built-in `http`/`fs`/`crypto` only — no
`npm install` needed, nothing to compile) that replaces the three Claude
Artifact capabilities the original page used:

| Artifact capability | Self-hosted replacement |
|---|---|
| `db`     | JSON-file store (`data/store.json`) behind a tiny REST API |
| `user`   | one shared password for the whole team (session cookie) |
| `assets` | `/api/upload` (base64 JSON) + `/uploads/:id` static serving |

The frontend (`public/app.html`) is the same Hub, with only the capability
bootstrap block swapped for a `fetch()`-based client that talks to this
server — none of the business logic (segmentation, funnels, reports,
analytics) changed.

## Run locally

```
APP_PASSWORD=your-shared-password node server.js
```

Open `http://localhost:8080`. Data persists in `data/store.json` and
`data/uploads/` — back these up like you would any database.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `APP_PASSWORD` | yes (in production) | shared login password for the whole team |
| `SESSION_SECRET` | recommended | signs the login cookie; set a fixed random value so sessions survive restarts/deploys |
| `DATA_DIR` | no | where `store.json` + `uploads/` live (default: `./data`) — **point this at your persistent volume** |
| `PORT` | no | default `8080`; most hosts set this for you |

Generate a `SESSION_SECRET` once with:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Deploying on Railway (recommended)

1. Create a Railway account at railway.app and a new empty project.
2. Add a **Volume**, mount path `/app/data`.
3. Set environment variables on the service: `APP_PASSWORD`, `SESSION_SECRET`,
   `DATA_DIR=/app/data`.
4. Deploy this folder either by connecting the GitHub repo it's pushed to,
   or via the CLI: `railway login` then `railway up` from this directory.
   Railway's Nixpacks builder detects `package.json`'s `"start"` script
   (`node server.js`) automatically — no Dockerfile needed.
5. Railway gives you a `*.up.railway.app` URL (custom domain optional).

Because the whole thing has zero npm dependencies, this also deploys
unchanged on Render, Fly.io, a plain VPS (`pm2 start server.js` or a
systemd unit), or literally any host that runs Node 18+.

## Migrating real data from the Claude artifact

Once the prototype is approved, the ~450 partners + history currently in
the artifact's `db` capability can be exported (via `ArtifactData` reads)
and loaded straight into `data/store.json` under the matching collection
keys (`partners`, `tasks`, `posts`, `platformMetrics`, `categorySnapshots`,
`sprints`, `weeklyReports`, `monthlyReports`, plus the `partners/<id>/touches`
and `tasks/<id>/comments` subcollections) — same shape, just `{data, version,
updatedAt}` per document instead of Firestore-style docs. Ask for this step
explicitly; it's deliberately separate from standing up the prototype itself.

## What's intentionally simple for v1

- No per-field optimistic-concurrency checks (`if_version`) on writes — fine
  for two people; worth adding if a third editor joins.
- "Who's acting" is a manual name picker (Данил Lead / Данил Mng), remembered
  per-browser in `localStorage` — there's no real per-user login, matching
  the "one shared password" choice made for this prototype.
- No HTTPS termination — put this behind the hosting platform's own TLS
  (Railway/Render do this automatically) or a reverse proxy if self-hosting
  on a bare VPS.
