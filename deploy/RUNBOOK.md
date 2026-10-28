# Desyn production runbook (Convex Cloud + shared Hetzner host)

Everything here runs from the owner's workstation (the repository checkout with `.env.keys`) with
`--host hetzner` (an SSH alias with passwordless `sudo` or root) unless it says "on the server". Every script
prints what it does, supports `--dry-run` and `--help`, and only touches resources named `desyn*`. Never paste
secret values into chat, tickets or commits: refer to the file and variable name instead.

## 1. What runs where

```
 Browser ──────────────► Convex Cloud  <deployment>.<region>.convex.cloud          (queries, mutations, sync websocket)
    │                        ▲   │      <deployment>.<region>.convex.site           (HTTP actions: Better Auth,
    │                        │   │                                                   /stripe/webhook, /api/v1, /mcp)
    │                        │   │ POST /v1/render|thumbnail|...  x-desyn-secret
    ▼                        │   ▼
 host nginx (shared, :80/:443, certbot, pre-launch basic auth on the human-facing hosts)
   desyn.app ─────────► desyn_landing  127.0.0.1:47100 | 47120  landing-blue | landing-green
   www.desyn.app ─────► 301 desyn.app
   app.desyn.app ─────► desyn_web      127.0.0.1:47101 | 47121  web-blue | web-green (container port 4100)
                          ├ /api/auth/*: the Next app proxies it to the Convex site URL (first-party cookies)
                          └ /api/v1/*, /mcp: nginx proxies them straight to the Convex site URL (no basic auth)
   docs.desyn.app ────► desyn_docs     127.0.0.1:47102 | 47122  docs-blue | docs-green (fallback: desyn.app/docs)
   render.desyn.app ──► desyn_worker   127.0.0.1:47103 | 47123  worker-blue | worker-green (no basic auth;
                                                                x-desyn-secret required; POST /v1/* + GET /healthz)
 S3 eu-central-1: desyn-prod-assets (uploads, via presigned URLs), desyn-prod-backups (backups/, assets-mirror/)
```

| Item | Value |
| --- | --- |
| Convex Cloud | prod and dev deployments: `CONVEX_DEPLOYMENT`, `CONVEX_DEV_DEPLOYMENT` in `deploy/env/public.env` |
| Compose project | `desyn` (file `/opt/desyn/tooling/compose/desyn.prod.yml`), docker network `desyn_net` |
| Reserved host ports | `127.0.0.1:47100-47199` (used: 47100-47103, 47120-47123) |
| Root directory | `/opt/desyn` (`tooling/`, `releases/<id>/src`, `state/`, `secrets/` 0700, `backups/` 0700) |
| nginx files | `/etc/nginx/sites-available/desyn-*.conf`, `/etc/nginx/desyn/{snippets,local}`, `/etc/nginx/desyn.htpasswd` |
| Certificate | certbot `--cert-name desyn` (desyn.app, www, app, docs, render), webroot `/var/www/desyn-acme`, deploy hook reloads nginx |
| systemd | `desyn-backup.timer` (03:17 UTC nightly), `desyn-logship.service` (enabled once `axiom.env` exists) |
| Resource caps | worker 4 CPU/6 GB, web 2/2 GB, landing 1/1 GB, docs 0.5/768 MB per colour; image builder 6 CPU/16 GB |

Release ids look like `r20261020143000-abc1234`; images are `desyn/<service>:<release>` plus
`desyn/convex-cli:<version>` (the Convex CLI used by backups and restores).

## 2. First deploy

### 2.1 Preflight (read-only)

```sh
deploy/scripts/lint.sh                      # optional, validates everything locally
deploy/scripts/preflight.sh --host hetzner
```

Fix every `BLOCKER` (port in 47100-47199 taken by something else, a non-desyn nginx site already claiming a desyn
hostname, disk nearly full, nginx without the Debian `sites-enabled` layout). preflight also lists the outbound
HTTPS routes the host needs (Convex Cloud, S3, Docker Hub, GHCR, npm, crates.io, GitHub).

### 2.2 DNS records (done: Vercel DNS)

| Name | Type | Value |
| --- | --- | --- |
| `desyn.app` (apex) | A | `<server IPv4>` |
| `www.desyn.app` | A | `<server IPv4>` |
| `app.desyn.app` | A | `<server IPv4>` |
| `docs.desyn.app` | A | `<server IPv4>` |
| `render.desyn.app` | A | `<server IPv4>` |
| `desyn.app` | CAA | `0 issue "letsencrypt.org"` (recommended) |

Add `AAAA` records only if the host has a global IPv6 (preflight prints the host addresses). There are no
`convex.`, `convex-site.` or `dash.` records: Convex is Convex Cloud. SES records (DKIM/SPF/DMARC, MAIL FROM
`mail.desyn.app`) are managed with SES.

### 2.3 Accounts and keys on the workstation

All secrets live in `.env.keys` (and `.env`) at the repository root, never committed. Scripts read them and never
print values; `python3 deploy/scripts/server-env.py prod --check` lists missing names.

| Name in `.env.keys` | Used for |
| --- | --- |
| `OPENROUTER_API_KEY`, `FAL_AI_API_KEY`, `STRIPE_*`, `ADMIN_EMAILS` (comma-separated operator accounts), `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (IAM `desyn-app`), OAuth ids, `AXIOM_*`, ... | Convex function env (`convex-cloud-env.py prod`) |
| `BETTER_AUTH_SECRET_PROD`, `AI_KEY_ENCRYPTION_SECRET_PROD`, `RENDER_WORKER_SECRET_PROD` | generated once by `convex-cloud-env.py`; the worker secret also goes to the server (`worker.env`) |
| `BACKUP_AWS_ACCESS_KEY_ID`, `BACKUP_AWS_SECRET_ACCESS_KEY` | IAM user `desyn-backup` (`deploy/aws/iam-setup.sh`): server `backup.env` |
| `CONVEX_DEPLOY_KEY_PROD` | prod deploy key for `convex export`/`import` on the server (`convex-backup.env`); `server-env.py` creates it with your Convex login if missing |
| `AXIOM_TOKEN`, `AXIOM_DATASET` | log shipping (`axiom.env`, optional) |

Log in to the Convex CLI once (`npx convex login`; the deploy uses that login, or `CONVEX_DEPLOY_KEY` when it is
exported). Apply the backup retention rule once as the AWS owner: `bash deploy/aws/backup-lifecycle.sh`.

### 2.4 Bootstrap

```sh
deploy/scripts/bootstrap.sh --host hetzner --dry-run     # review
deploy/scripts/bootstrap.sh --host hetzner
```

Creates the `desyn` system user, `/opt/desyn` (with `secrets/` 0700, empty), the basic-auth user `desyn` with a
random password in `/root/desyn-basic-auth.txt` (0600), the nginx HTTP/ACME server block, the docker network
`desyn_net`, the CPU/memory-capped buildx builder `desyn-builder`, and the systemd units. Re-running it never
overwrites a file it generated before.

### 2.5 Certificates (DNS already resolves to the server)

```sh
deploy/scripts/certs.sh --host hetzner --email ops@desyn.app --acme-test   # staging round trip, saves nothing
deploy/scripts/certs.sh --host hetzner --email ops@desyn.app
```

One ECDSA certificate covers desyn.app, www, app, docs and render. certs.sh refreshes the HTTP/ACME server block,
checks DNS and the webroot, then installs the TLS server blocks (`desyn-landing|app|docs|render.conf`), runs
`nginx -t` and reloads; if nginx rejects them they are disabled again and the host keeps serving. Server blocks of
the former self-hosted Convex setup (`desyn-convex.conf`, `desyn-dash.conf`) are removed. Renewal uses the host's
certbot timer (`certs.sh --renew-test` checks it).

### 2.6 First rollout

```sh
deploy/scripts/deploy.sh --host hetzner --dry-run
deploy/scripts/deploy.sh --host hetzner
```

`deploy.sh` ships `git archive HEAD` (commit first; the Convex functions are pushed from your checkout, so
`convex/`, `packages/`, `config/` and the manifests must match `HEAD`) or, with `--worktree`, the working tree
minus ignored files and every `.env*` except `.env.example` (the package is checked again before upload). Then:

1. **server, build**: images are built on the server in `desyn-builder` (alternatives: `--build local` builds here
   and streams `docker save | ssh docker load`; `--build registry --registry ghcr.io/<owner> --tag v1.2.3` pulls
   the images `release.yml` pushed, after `ssh -t hetzner sudo docker login ghcr.io` with a `read:packages`
   token). `desyn/convex-cli:<version>` is built once per Convex CLI version. When the functions are part of the
   deploy, a pre-deploy backup runs (not on the first deploy).
2. **workstation, env**: `convex-cloud-env.py prod` pushes the Convex function env (generating missing internal
   secrets into `.env.keys`); `server-env.py prod --host hetzner` writes `/opt/desyn/secrets/*.env` (root 0600,
   atomically, verified by checksum; reports created/updated/unchanged).
3. **workstation, functions**: `convex deploy --yes --typecheck enable` to the prod deployment (your CLI
   login via a private env file with its `CONVEX_DEPLOYMENT`; with `CONVEX_DEPLOY_KEY` exported, the
   key, which must belong to that deployment).
4. **server, rollout**: worker, landing, web, docs blue/green (new colour started, health-checked on its
   127.0.0.1 port, old colour stopped; nginx skips whichever port is down), then `healthcheck.sh`. Any failure rolls
   the services back to the previous release automatically.

Images are never pulled implicitly: the compose file sets `pull_policy: never` for every `desyn/*` image.

### 2.7 Verify

```sh
deploy/scripts/healthcheck.sh --host hetzner --public
ssh -t hetzner sudo cat /root/desyn-basic-auth.txt        # basic-auth credentials, read on screen only
```

Then in a browser: `https://desyn.app` (basic-auth prompt, then the landing page), `https://app.desyn.app`
(sign-up/sign-in: the app's `/api/auth` proxy talks to the Convex site URL server-side; the browser's Convex
websocket goes to `*.convex.cloud`), `https://docs.desyn.app`. An export from the editor exercises Convex Cloud ->
`render.desyn.app`.

How the pre-launch gate decides (`desyn-00-common.conf`): desyn.app, www, app. and docs. ask for basic auth and
then set the `desyn_gate` cookie for `.desyn.app` (30 days), so moving between them does not prompt again.
Requests from this host and `desyn_net` are trusted. `render.desyn.app` never asks for basic auth: it only accepts
`POST /v1/{render,thumbnail,describe,layout,measure,apply}` with an `x-desyn-secret` header of plausible length
(32-512 visible characters; the worker compares the value) and `GET /healthz`, rate limited per address, and it
never hands out the gate cookie. `app.desyn.app/api/v1/*` and `/mcp` (Agent API, MCP) never ask for basic auth
either (API keys use the same `Authorization` header, and the endpoints are public on `*.convex.site` anyway):
nginx passes them to the Convex site URL, re-resolving its address through `/etc/nginx/desyn/local/resolver.conf`
(the host's nameservers, written by bootstrap) and verifying its certificate. Convex Cloud, the Stripe webhook
and native apps talk to the `*.convex.site` URL directly, so the gate never blocks them.

### 2.8 Enabling launch

1. `deploy/scripts/basic-auth.sh --host hetzner off` - the single switch (`/etc/nginx/desyn/local/auth-switch.conf`),
   validated with `nginx -t` before the reload. `on` reverts it. render.desyn.app is unaffected either way.
2. Raise HSTS: set `max-age=31536000` in `deploy/nginx/desyn/snippets/hsts.conf`, commit, then
   `deploy/scripts/certs.sh --host hetzner --sites-only`. Add `preload` only after weeks without issues.
3. Stripe live mode: live keys in `.env.keys` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price ids in
   `deploy/env/public.env`), `deploy.sh --host hetzner --only convex` (pushes the env and the functions).
4. Raise DNS TTLs to 3600.

## 3. Day to day

| Task | Command |
| --- | --- |
| Deploy current commit | `deploy/scripts/deploy.sh --host hetzner` |
| Deploy one service | `deploy/scripts/deploy.sh --host hetzner --only web` (env files are synced too) |
| Functions only | `deploy/scripts/deploy.sh --host hetzner --only convex` (backup, env push, `convex deploy`) |
| Apply changed env files without new code | `deploy/scripts/deploy.sh --host hetzner --only worker,web --force-switch` |
| Hetzner only, functions from CI | `deploy/scripts/deploy.sh --host hetzner --skip-convex` |
| Health | `deploy/scripts/healthcheck.sh --host hetzner [--public]` |
| Logs | `deploy/scripts/logs.sh --host hetzner web -f --since 30m` / `logs.sh --host hetzner --nginx render`; functions: `npx convex logs --prod` |
| Roll back the services | `deploy/scripts/rollback.sh --host hetzner --list` then `rollback.sh --host hetzner [--to <id>]` |
| Manual backup | `deploy/scripts/backup.sh --host hetzner --label manual` |
| Basic auth | `basic-auth.sh --host hetzner status|on|off|rotate-password|rotate-gate|add-user NAME` |
| Env file review | `python3 deploy/scripts/server-env.py prod --dry-run` (names only) |
| Deploy log | on the server: `/opt/desyn/state/history/<release>.log`, `/opt/desyn/state/releases.log` |

The last 5 releases (sources + images) are kept for rollbacks (`--keep N` changes it). Releases whose images are
still referenced in `/opt/desyn/state/images.env` (for example the worker image after a series of `--only web`
deploys, or an idle colour) are never pruned.

### Convex functions

- Functions deploy before the services roll and are **not** reverted when a rollout fails or `rollback.sh` runs.
  Keep every change compatible with the previous release: add fields and functions first, remove them in a later
  release (expand/contract). To revert functions on purpose: `deploy.sh --host hetzner --ref <sha> --only convex`.
- Large index changes stop `convex deploy` with a confirmation; stage them, or pass
  `--convex-flag --skip-large-indexes-check` when the backfill is acceptable.
- CI path: create the GitHub secret once with `deploy/scripts/github-deploy-key.sh` (environment `production`).
  `convex-deploy.yml` can then be run by hand for any ref, and `release.yml` runs it after the images of a `v*` tag
  when the repository variable `DESYN_CONVEX_DEPLOY_ON_RELEASE` is `true`. Follow with
  `deploy.sh --host hetzner --build registry --registry ghcr.io/<owner> --tag <tag> --skip-convex`.
- The function env is only pushed from the workstation (`convex-cloud-env.py prod`, also part of `deploy.sh`).

## 4. Backups and restore

`desyn-backup.timer` runs `backup.sh --label nightly` at 03:17 UTC (+ up to 20 min jitter); every deploy that
includes the Convex functions runs `backup.sh --label pre-<release>` before they change (on the server during the
build phase, or over SSH for functions-only deploys). A backup `/opt/desyn/backups/<UTC>-<label>/` contains:

- `convex-export.zip` - `convex export` of the prod deployment (all tables incl. component tables, plus
  Convex file storage with `BACKUP_INCLUDE_FILE_STORAGE=1`), made by `desyn/convex-cli:<version>` with the prod
  deploy key (`convex-backup.env`, handed only to that container); restored with `convex import`
- `manifest.json` - deployment, release, CLI version, size, sha256

It is uploaded to `s3://desyn-prod-backups/backups/<id>/` (SSE-S3) with the `desyn-backup` IAM user, which can write
and read but not delete. Retention is the bucket lifecycle rule (`deploy/aws/backup-lifecycle.json`: `backups/`
expires after 30 days). User uploads (`desyn-prod-assets`) are copied server-side into
`s3://desyn-prod-backups/assets-mirror/` on every run (nothing is deleted from the mirror). Local copies are kept 3
days. `healthcheck.sh` warns when the last backup is older than 36 h; `systemctl status desyn-backup.service`
shows the last run. Convex Cloud offers its own backups too (dashboard -> Backups, depending on the plan); these
exports are the independent copy outside Convex.

### Restore drill (monthly; touches nothing in production)

```sh
deploy/scripts/restore.sh --host hetzner --list
deploy/scripts/restore.sh --host hetzner --backup <id> --drill
```

Downloads the backup, verifies its checksum, starts a throwaway self-hosted Convex backend (pinned image, SQLite,
isolated internal network), deploys the current release's functions to it (tool image built from the release
source; `--no-functions` skips that), imports the export with `--replace-all`, lists every table with its
document count, and removes it all. Record the date and duration in the ops log.

### Real restore

```sh
deploy/scripts/restore.sh --host hetzner --backup <id> --mode import
```

Takes a fresh pre-restore backup first, asks for a typed confirmation, then runs `convex import --replace-all` of
the export into the production deployment. For a point-in-time restore inside Convex Cloud's own retention, the
Convex dashboard (Backups) is faster.

### Rebuilding the Hetzner host

Nothing on the host is stateful except `/opt/desyn/backups` (copies of S3) and the basic-auth password. On a new
host: DNS -> preflight -> bootstrap -> certs -> `deploy.sh` (rewrites every env file from `.env.keys`).

## 5. Incident playbook

Always start with `healthcheck.sh --host hetzner` and `logs.sh --host hetzner <service> --since 15m`.

| Symptom | Action |
| --- | --- |
| 502 on one site right after a deploy | The deploy auto-rolls back; if it did not, `rollback.sh --host hetzner`. Check `/opt/desyn/state/history/<release>.log`. |
| 502 on every desyn site | `docker ps` on the server; if the host rebooted, containers come back via `restart: unless-stopped` - check `systemctl status docker`. |
| App loads but data does not | Convex Cloud: `healthcheck.sh` shows `<deployment>.convex.site/healthz`; check status.convex.dev and `npx convex logs --prod`. Not fixed by rolling back the host. |
| Exports / thumbnails fail | `healthcheck.sh --public` (render checks), `logs.sh --nginx render`, `logs.sh worker`. A 401 at nginx means Convex sends no or a malformed `x-desyn-secret`; a 401/403 from the worker means the secrets differ: `deploy.sh --host hetzner --only worker,convex --force-switch` pushes `RENDER_WORKER_SECRET_PROD` to both. |
| Agent API / MCP on app.desyn.app answers 502/504 | `healthcheck.sh --public` (check `app.desyn.app/api/v1 -> Convex`), `logs.sh --nginx app`: "could not be resolved" means `/etc/nginx/desyn/local/resolver.conf` names a dead nameserver (delete it, rerun `bootstrap.sh`); "upstream SSL certificate verify" means the host CA bundle (`/etc/ssl/certs/ca-certificates.crt`) is stale (`apt-get install --only-upgrade ca-certificates`, host admin). |
| Disk > 90 % | `docker system df`; `docker image ls 'desyn/*'` then `docker image rm` ids outside the last 5 releases; `docker buildx prune --builder desyn-builder --keep-storage 20gb`; local backups (`/opt/desyn/backups`). Never prune other projects' images. |
| Certificate < 7 days | `certs.sh --host hetzner --renew-test`; check `systemctl list-timers | grep certbot`; reissue with `certs.sh`. |
| Leaked third-party key | Revoke at the provider, put the new value in `.env.keys`, `deploy.sh --host hetzner --only convex` (pushes the env). |
| Leaked render worker secret | Remove `RENDER_WORKER_SECRET_PROD` from `.env.keys`, then `deploy.sh --host hetzner --only convex,worker --force-switch` (a new secret is generated and pushed to Convex and the worker). |
| Leaked Convex deploy key | Delete it in the Convex dashboard (Production -> Settings -> Deploy keys), remove `CONVEX_DEPLOY_KEY_PROD` from `.env.keys` (or rotate the GitHub secret with `github-deploy-key.sh`), `deploy.sh --host hetzner --skip-convex` (a new server key is created and placed). |
| Leaked basic-auth password | `basic-auth.sh --host hetzner rotate-password` (new password and a new gate token, so every 30-day `desyn_gate` cookie stops working too). Only the cookie leaked: `basic-auth.sh --host hetzner rotate-gate`. |
| Abuse / traffic spike | nginx rate limits answer 429 (`logs.sh --nginx app`); block offenders with `ufw deny from <ip>` (host-wide, coordinate with other tenants) or add `deny <ip>;` in the desyn server block and `certs.sh --sites-only`. |
| Data corruption / bad migration | Stop writes (`basic-auth.sh on`), `restore.sh --drill` the newest good backup, then `--mode import` (or the Convex dashboard restore). |
| Rollback failed | Deploy the last known-good commit explicitly: `deploy.sh --host hetzner --ref <sha> --skip-backup --skip-convex`. |

## 6. Upgrades

- **Desyn releases**: `deploy.sh`. CI (`ci.yml`) must be green; `release.yml` builds GHCR images on `v*` tags.
- **Convex CLI** (the `convex` dependency): bump it in the root `package.json`; the next deploy builds the matching
  `desyn/convex-cli:<version>` and backups switch to it.
- **Base images** (node, rust/cargo-chef, debian, ffmpeg): bump the `ARG` defaults in `deploy/docker/*.Dockerfile`.
- **Host** (Ubuntu, Docker, nginx): owned by the host admin. After nginx upgrades run `deploy/scripts/lint.sh`
  locally with the new version and `healthcheck.sh`; bootstrap picks `http2 on;` automatically on nginx >= 1.25.1
  only for new hosts - to switch an existing host delete `/etc/nginx/desyn/local/listen-443.conf` and rerun bootstrap.
- **Host files added by newer releases** (`/etc/nginx/desyn/local/resolver.conf` for the `/api/v1` + `/mcp` proxy):
  `certs.sh` refuses to run while one is missing; `bootstrap.sh --host hetzner` adds it and keeps every existing
  file. If the host's DNS servers change, delete `resolver.conf` and rerun bootstrap.

## 7. Uninstall

```sh
deploy/scripts/uninstall.sh --host hetzner --dry-run
deploy/scripts/uninstall.sh --host hetzner                       # keeps env files, local backups, certificate
deploy/scripts/uninstall.sh --host hetzner --purge-data --delete-certs
```

Uninstalling the host never touches Convex Cloud or S3.
