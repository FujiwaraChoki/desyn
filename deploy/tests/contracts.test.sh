#!/usr/bin/env bash
# Cross-file consistency of the production setup (no network, no root):
#   * host ports: lib/common.sh = compose/desyn.prod.yml = nginx upstreams, all in 127.0.0.1:47100-47199
#   * hostnames: lib/common.sh DESYN_DOMAINS = desyn-acme.conf = the TLS server blocks
#   * Convex Cloud: CSP origins and convex-cloud-env.py match deploy/env/public.env; no self-hosted Convex host,
#     service or env file is left in the production files
#   * env files: every compose env_file has a template in deploy/env/server; every template reference is a
#     public.env name or a documented .env.keys name
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v python3 >/dev/null 2>&1 || {
  echo "SKIP contracts: python3 missing"
  exit 0
}

out="$(python3 -I - "${DEPLOY_DIR}" <<'EOF'
import re, sys
from pathlib import Path

d = Path(sys.argv[1])
results = []
def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL") + " " + name + ("" if ok else f" :: {detail}"))

common = (d / "scripts/lib/common.sh").read_text()
compose = (d / "compose/desyn.prod.yml").read_text()
nginx_common = (d / "nginx/sites-available/desyn-00-common.conf").read_text()
public = dict(re.findall(r"^([A-Z][A-Z0-9_]*)=(.*)$", (d / "env/public.env").read_text(), re.M))

# Ports.
ports = {f"{svc}:{col}": int(p) for svc, col, p in re.findall(r"\[(\w+):(blue|green)\]=(\d+)", common)}
check("common.sh defines blue/green ports for worker, landing, web, docs",
      sorted({k.split(":")[0] for k in ports}) == ["docs", "landing", "web", "worker"] and len(ports) == 8, ports)
compose_ports = {}
for svc, col in re.findall(r"^  (\w+)-(blue|green):$", compose, re.M):
    block = compose.split(f"  {svc}-{col}:\n", 1)[1].split("\n\n", 1)[0]
    m = re.search(r'"127\.0\.0\.1:(\d+):\d+"', block)
    compose_ports[f"{svc}:{col}"] = int(m.group(1)) if m else None
check("compose publishes exactly the common.sh ports", compose_ports == ports, (compose_ports, ports))
upstreams = {}
for name, body in re.findall(r"upstream desyn_(\w+) \{(.*?)\}", nginx_common, re.S):
    upstreams[name] = sorted(int(p) for p in re.findall(r"127\.0\.0\.1:(\d+)", body))
for svc in ("worker", "landing", "web", "docs"):
    check(f"nginx upstream desyn_{svc} = compose ports", upstreams.get(svc) == sorted([ports[f"{svc}:blue"], ports[f"{svc}:green"]]),
          upstreams.get(svc))
check("no upstream for a self-hosted Convex backend", not any(k.startswith("convex") for k in upstreams), list(upstreams))
check("all ports in the reserved range", all(47100 <= p <= 47199 for p in ports.values()))
check("compose binds every port to 127.0.0.1 only",
      not re.search(r'^\s*-?\s*"?(0\.0\.0\.0:)?\d+:\d+"?\s*$', compose, re.M) and "ports:" in compose)
check("no postgres / convex-backend / dashboard in production compose",
      not re.search(r"^\s{2}(postgres|convex-backend|convex-dashboard):", compose, re.M))
check("web listens on 4100 inside the container", compose.count('PORT: "4100"') == 2 and ":4100\"]" in compose)

# Hostnames.
domains = re.search(r"DESYN_DOMAINS=\(([^)]*)\)", common).group(1).split()
acme = re.search(r"server_name ([^;]+);", (d / "nginx/sites-available/desyn-acme.conf").read_text()).group(1).split()
check("ACME server lists DESYN_DOMAINS", sorted(acme) == sorted(domains), (acme, domains))
tls = []
for f in sorted((d / "nginx/sites-available").glob("desyn-*.conf")):
    if f.name in ("desyn-00-common.conf", "desyn-acme.conf"):
        continue
    tls += [n for m in re.findall(r"server_name ([^;]+);", f.read_text()) for n in m.split()]
check("TLS server blocks serve exactly DESYN_DOMAINS", sorted(tls) == sorted(domains), (tls, domains))
check("render.desyn.app is served", "render.desyn.app" in domains)
check("no convex./convex-site./dash. hosts", not any(h.split(".")[0] in ("convex", "convex-site", "dash") for h in domains))
tls_sites = re.search(r"DESYN_NGINX_TLS_SITES=\(([^)]*)\)", (d / "scripts/lib/nginx.sh").read_text()).group(1).split()
check("nginx.sh installs every TLS server block", sorted(tls_sites) == sorted(
    f.name for f in (d / "nginx/sites-available").glob("desyn-*.conf") if f.name not in ("desyn-00-common.conf", "desyn-acme.conf")), tls_sites)

# Convex Cloud.
cloud = public["NEXT_PUBLIC_CONVEX_URL"].removeprefix("https://")
site = public["NEXT_PUBLIC_CONVEX_SITE_URL"]
app_csp = (d / "nginx/desyn/snippets/csp-app.conf").read_text()
landing_csp = (d / "nginx/desyn/snippets/csp-landing.conf").read_text()
check("app CSP allows wss:// of the Convex Cloud deployment", f"wss://{cloud}" in app_csp)
check("landing CSP allows the Convex Cloud API, websocket and site URL",
      all(x in landing_csp for x in (f"https://{cloud}", f"wss://{cloud}", site)))
site_proxy = (d / "nginx/desyn/snippets/convex-site.conf").read_text()
site_host = site.removeprefix("https://").rstrip("/")
check("Agent API / MCP proxy targets the Convex Cloud site URL",
      f'set $desyn_convex_site_host "{site_host}";' in site_proxy and "proxy_pass https://$desyn_convex_site_host;" in site_proxy)
check("Agent API / MCP proxy verifies the Convex TLS certificate with SNI",
      all(x in site_proxy for x in ("proxy_ssl_verify on;", "proxy_ssl_server_name on;", "proxy_ssl_name $desyn_convex_site_host;")))
check("Agent API / MCP proxy never hands out the gate cookie and skips basic auth",
      'set $desyn_cookie "";' in site_proxy and "auth_basic off;" in site_proxy)
app_conf = (d / "nginx/sites-available/desyn-app.conf").read_text()
check("app.desyn.app passes /api/v1/ and /mcp to the Convex site",
      all(re.search(rf"location {loc} \{{\s*include desyn/snippets/convex-site\.conf;\s*\}}", app_conf)
          for loc in (r"\^~ /api/v1/", r"= /mcp", r"\^~ /mcp/")))
check("the resolver file the proxy includes is a documented local file",
      "resolver.conf" in (d / "scripts/lib/nginx.sh").read_text() and (d / "nginx/desyn/local.example/resolver.conf").exists())
snippets = "".join(f.read_text() for f in (d / "nginx").rglob("*.conf"))
check("no self-hosted Convex hostnames in nginx", not re.search(r"(convex|convex-site|dash)\.desyn\.app", snippets))
cloud_env = (d / "scripts/convex-cloud-env.py").read_text()
check("Convex env points RENDER_WORKER_URL at render.desyn.app",
      f'"RENDER_WORKER_URL": "{public["RENDER_WORKER_PUBLIC_URL"]}"' in cloud_env)
check("common.sh prod deployment = public.env CONVEX_DEPLOYMENT",
      f'DESYN_CONVEX_PROD_DEPLOYMENT="{public["CONVEX_DEPLOYMENT"]}"' in common)
check("server-env.py prod deployment = public.env CONVEX_DEPLOYMENT",
      f'"deployment": "{public["CONVEX_DEPLOYMENT"]}"' in (d / "scripts/server-env.py").read_text())
selfhost = (d / "compose/desyn.selfhost.yml").read_text()
backend_pin = re.search(r"convex-backend:\$\{CONVEX_BACKEND_TAG:-([0-9a-f]{40})\}", selfhost)
check("restore drill backend = the self-host pin", backend_pin is not None and backend_pin.group(1) in common)

# Env files.
templates = {f.name for f in (d / "env/server").glob("*.env")}
env_files = set(re.findall(r"secrets/([a-z-]+\.env)", compose))
check("every compose env_file has a template", env_files <= templates, env_files - templates)
keys_names = {"RENDER_WORKER_SECRET_PROD", "BACKUP_AWS_ACCESS_KEY_ID", "BACKUP_AWS_SECRET_ACCESS_KEY",
              "CONVEX_DEPLOY_KEY_PROD", "AXIOM_TOKEN", "AXIOM_DATASET"}
unknown = set()
for f in (d / "env/server").glob("*.env"):
    for refs in re.findall(r"\$\{([A-Z0-9_|]+)", f.read_text()):
        for name in refs.split("|"):
            if name not in public and name not in keys_names:
                unknown.add(f"{f.name}:{name}")
check("template references are public.env or documented .env.keys names", not unknown, sorted(unknown))
scripts = "".join(f.read_text() for f in (d / "scripts").glob("*.sh"))
for name in ("backup.env", "convex-backup.env", "axiom.env"):
    check(f"{name} is used by the scripts or units", name in scripts or name in (d / "systemd/desyn-logship.service").read_text())
check("the env README documents every template", all(t in (d / "env/README.md").read_text() for t in templates))

print("\n".join(results))
EOF
)"
while IFS= read -r line; do
  case "${line}" in
    PASS\ *) pass "${line#PASS }" ;;
    FAIL\ *) fail "${line#FAIL }" ;;
  esac
done <<<"${out}"
finish
