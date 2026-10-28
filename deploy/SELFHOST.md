# Self-hosting Desyn

Desyn is source-available under the Desyn Non-Commercial Source License (`LICENSE`): self-hosters get every
feature for non-commercial use. The self-hosted edition (`DESYN_EDITION=selfhost`) sends no telemetry: no
PostHog, DataFast or Axiom keys are read and the Convex usage beacon is disabled.

## What runs

`deploy/compose/desyn.selfhost.yml` (compose project `desyn-selfhost`):

| Service | Purpose | Default host port |
| --- | --- | --- |
| `web` | the app (editor, dashboard, settings) | 3000 |
| `convex-backend` | database, realtime, functions (self-hosted Convex) | 3210 (API), 3211 (HTTP actions) |
| `convex-dashboard` | Convex admin UI | 127.0.0.1:6791 |
| `postgres` | Convex persistence (internal network only) | - |
| `minio` + `minio-init` | S3-compatible storage for uploads (bucket created automatically) | 9000 (API), 127.0.0.1:9001 (console) |
| `worker` | render/export worker (PNG/PDF/PPTX/MP4) | - |
| profile `marketing` | `landing` + `docs` | 3001, 3002 |
| profile `mail` | Mailpit SMTP sink | 127.0.0.1:8025 (UI) |
| profile `ollama` | local models | 127.0.0.1:11434 |
| profile `tools` | `convex-tools`: the Convex CLI with this repo's functions | - |

Ports bind to `DESYN_BIND` (default `127.0.0.1`). For other machines either set `DESYN_BIND=0.0.0.0` on a trusted
network or put a TLS reverse proxy in front (recommended) and update the `DESYN_*_URL` values.

## Quick start

```sh
cp deploy/compose/.env.example deploy/compose/.env
# fill POSTGRES_PASSWORD, INSTANCE_SECRET, MINIO_ROOT_PASSWORD, RENDER_WORKER_SECRET with `openssl rand -hex 32`
cp deploy/compose/convex.selfhost.env.example deploy/compose/convex.env
# fill BETTER_AUTH_SECRET, AI_KEY_ENCRYPTION_SECRET (openssl rand -hex 32), RENDER_WORKER_SECRET (same as .env),
# AWS_SECRET_ACCESS_KEY (= MINIO_ROOT_PASSWORD), S3_ENDPOINT (see below), optional AI keys

C="docker compose -f deploy/compose/desyn.selfhost.yml"
$C up -d --build                                   # first build takes a while (Rust + Next.js)
$C exec convex-backend ./generate_admin_key.sh     # copy the key into CONVEX_SELF_HOSTED_ADMIN_KEY in .env
grep -E '^[A-Z0-9_]+=.+' deploy/compose/convex.env | $C run --rm -T convex-tools env set --force
$C run --rm convex-tools deploy --yes              # pushes the Convex functions
```

Open `http://localhost:3000`. The dashboard at `http://127.0.0.1:6791` asks for the admin key.

`S3_ENDPOINT` must be reachable both by browsers (presigned uploads) and by the containers. `localhost` only works
for a single-machine setup where nothing in a container fetches objects; use your LAN address
(`http://192.168.1.20:9000`) or a domain routed to MinIO (`https://s3.example.com`), and set the matching
`S3_PUBLIC_BASE_URL` (`<endpoint>/<bucket>`). Any other S3-compatible store (R2, Hetzner Object Storage, AWS)
works the same way; then the bundled MinIO can stay unused.

Optional profiles: `$C --profile marketing --profile mail --profile ollama up -d`. With `mail`, set
`MAIL_TRANSPORT=smtp` and `SMTP_URL=smtp://mailpit:1025` in `convex.env`; with `ollama`, `OLLAMA_BASE_URL=http://ollama:11434`
(pull a model: `$C exec ollama ollama pull <model>`).

## Reverse proxy example (Caddy)

```
app.example.com      { reverse_proxy 127.0.0.1:3000 }
convex.example.com   { reverse_proxy 127.0.0.1:3210 }
site.example.com     { reverse_proxy 127.0.0.1:3211 }
s3.example.com       { reverse_proxy 127.0.0.1:9000 }
```

Then set `DESYN_APP_URL=https://app.example.com`, `DESYN_CONVEX_URL=https://convex.example.com`,
`DESYN_CONVEX_SITE_URL=https://site.example.com` in `.env`, the matching `APP_URL`/`S3_ENDPOINT` in `convex.env`,
and rebuild the web image (`$C up -d --build web`) because the public URLs are baked into the client bundle.
The production nginx configuration in `deploy/nginx/` is an example of the security headers, CSP and blue/green
upstreams (hosted production uses Convex Cloud, so it has no Convex server block). When nginx fronts your Convex
backend, proxy the API host with websocket upgrade (`Upgrade` / `Connection` headers) and long read timeouts
(`proxy_read_timeout 3600s`), and set `X-Real-IP $remote_addr` on every host.

## Updating

```sh
git pull
$C up -d --build
$C run --rm convex-tools deploy --yes
```

Before updating the Convex backend image (`CONVEX_BACKEND_TAG`), take a backup (below).

## Backups

The `convex-tools` container runs as uid 1000, so the export directory must be writable for it:

```sh
mkdir -p backups && sudo chown 1000:1000 backups
$C run --rm -v "$PWD/backups:/out" convex-tools export --path /out/convex-$(date +%F).zip --include-file-storage
$C exec -T postgres pg_dump -U desyn -d desyn -Fc > backups/postgres-$(date +%F).dump
```

MinIO data lives in the `minio_data` volume; back it up with your usual volume/snapshot tooling. Restore a Convex
export with `$C run --rm -v "$PWD/backups:/in:ro" convex-tools import --replace-all --yes /in/<file>.zip`.
