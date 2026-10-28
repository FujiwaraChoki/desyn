#!/usr/bin/env python3
"""Generate the root-only env files of the Hetzner services from the owner's keys. Values are never printed.

Usage:
  python3 deploy/scripts/server-env.py prod --check                 which variables are missing (names only)
  python3 deploy/scripts/server-env.py prod --dry-run               file -> variable names that would be written
  python3 deploy/scripts/server-env.py prod --host hetzner          write /opt/desyn/secrets/<file> on the server
  python3 deploy/scripts/server-env.py prod --out DIR               write the files locally (0600), e.g. for review

Options:
  --root DIR               repository root (default: two levels above this script)
  --no-create-deploy-key   fail instead of creating the Convex deploy key used by backups (see below)
  --prune-retired          also delete env files of the former self-hosted Convex stack on the server

Sources, later wins: deploy/env/public.env (public ids), .env, .env.keys (the owner's keys; never committed).
Templates: deploy/env/server/<file>.env, one per service. Each line is NAME=TEMPLATE where TEMPLATE is literal
text with references:
  ${A}              required: the value of A (an error names A when it is missing)
  ${A|B}            the first of A, B that has a value (required)
  ${A:-text}        A, or the literal text when A is missing; ${A:-} makes the line optional (dropped when empty)
A file whose first comment line contains "@optional-file" is skipped (not an error) when a required name is missing.

Values must be plain single-line strings without quotes, "$", backslashes or surrounding spaces: the same file is
read by docker compose env_file (which would interpolate "$") and by `docker run --env-file` (which keeps quotes).

The prod Convex deploy key for `convex export` / `convex import` on the server (CONVEX_DEPLOY_KEY_PROD) is created
once with the owner's Convex CLI login (`npx convex deployment token create`, saved straight into a 0600 temp file,
never printed) and appended to .env.keys, unless --no-create-deploy-key is given.

On the server the files are written atomically as root:root 0600 into /opt/desyn/secrets (directory 0700): a tar
stream over ssh stdin is unpacked into a temp dir there and moved into place; the script then re-reads the remote
checksums to confirm every file arrived. It reports created / updated / unchanged per file.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ROOT = SCRIPT_DIR.parents[1]
TARGETS = {"prod": {"deployment": "prod:opulent-alpaca-530", "deploy_key_var": "CONVEX_DEPLOY_KEY_PROD"}}
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=15"]
# Env files of the retired self-hosted Convex production stack; removed with --prune-retired.
RETIRED = ("postgres.env", "convex-backend.env", "convex-functions.env", "convex-admin.env")
LINE = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
REF = re.compile(r"\$\{([A-Z][A-Z0-9_]*(?:\|[A-Z][A-Z0-9_]*)*)(?::-([^}]*))?\}")
UNSAFE = re.compile(r"[\s\"'`$\\]")


class TemplateError(Exception):
    pass


def read_env(path: Path) -> dict[str, str]:
    """KEY=VALUE lines; surrounding quotes are stripped, comments and malformed lines ignored."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        m = LINE.match(line)
        if not m:
            continue
        value = m.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[m.group(1)] = value
    return out


def load_sources(root: Path) -> dict[str, str]:
    merged: dict[str, str] = {}
    for rel in ("deploy/env/public.env", ".env", ".env.keys"):
        for key, value in read_env(root / rel).items():
            if value != "":
                merged[key] = value
    return merged


def render_template(path: Path, sources: dict[str, str]) -> tuple[list[tuple[str, str]], list[str], bool]:
    """Returns (assignments, missing names, optional_file). Values are kept in memory only."""
    assignments: list[tuple[str, str]] = []
    missing: list[str] = []
    optional_file = False
    seen_first_comment = False
    for number, raw in enumerate(path.read_text().splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            if not seen_first_comment:
                optional_file = "@optional-file" in line
                seen_first_comment = True
            continue
        m = LINE.match(line)
        if not m:
            raise TemplateError(f"{path.name}:{number}: expected NAME=TEMPLATE")
        name, template = m.group(1), m.group(2)
        line_missing: list[str] = []

        def substitute(ref: re.Match[str]) -> str:
            alternatives = ref.group(1).split("|")
            for alt in alternatives:
                if sources.get(alt):
                    return sources[alt]
            if ref.group(2) is not None:
                return ref.group(2)
            line_missing.append(ref.group(1))
            return ""

        value = REF.sub(substitute, template)
        if "${" in value:
            raise TemplateError(f"{path.name}:{number}: malformed reference in {name}")
        if line_missing:
            missing.extend(line_missing)
            continue
        if value == "":
            continue
        if UNSAFE.search(value) or "\x00" in value:
            raise TemplateError(
                f"{path.name}: the value for {name} contains whitespace, quotes, '$' or a backslash, which env files "
                "cannot carry safely; change the source value"
            )
        assignments.append((name, value))
    names = [n for n, _ in assignments]
    duplicates = sorted({n for n in names if names.count(n) > 1})
    if duplicates:
        raise TemplateError(f"{path.name}: duplicate names {', '.join(duplicates)}")
    return assignments, missing, optional_file


def file_content(template_name: str, assignments: list[tuple[str, str]]) -> bytes:
    header = (
        f"# Generated by deploy/scripts/server-env.py from deploy/env/server/{template_name}.\n"
        "# Root-only. Do not edit on the server: change .env.keys (or the template) and run the script again.\n"
    )
    return (header + "".join(f"{k}={v}\n" for k, v in assignments)).encode()


def convex_version(root: Path) -> str:
    try:
        deps = json.loads((root / "package.json").read_text()).get("dependencies", {})
    except (OSError, ValueError):
        deps = {}
    version = str(deps.get("convex", "1.47.0")).lstrip("^~=")
    return version if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) else "1.47.0"


def ensure_deploy_key(root: Path, target: str, sources: dict[str, str]) -> None:
    """Create the prod deploy key with the owner's CLI login and append it to .env.keys (never printed)."""
    spec = TARGETS[target]
    var = spec["deploy_key_var"]
    if sources.get(var):
        return
    keys_path = root / ".env.keys"
    if not keys_path.exists():
        raise TemplateError(f"{keys_path} does not exist; cannot store {var}")
    deployment = spec["deployment"]
    name = f"desyn-hetzner-{time.strftime('%Y%m%d')}"
    print(f"creating Convex deploy key '{name}' for {deployment} (stored in .env.keys as {var}, not printed)")
    with tempfile.TemporaryDirectory() as tmp:
        os.chmod(tmp, 0o700)
        key_file = Path(tmp) / "key.env"
        version = convex_version(root)
        (Path(tmp) / "package.json").write_text(
            json.dumps({"name": "desyn-key", "private": True, "dependencies": {"convex": version}}) + "\n"
        )
        env = {k: v for k, v in os.environ.items() if not k.startswith("CONVEX_")}
        env["CONVEX_DEPLOYMENT"] = deployment
        proc = subprocess.run(
            ["npx", "-y", f"convex@{version}", "deployment", "token", "create", name, "--save-env", str(key_file)],
            cwd=tmp,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        if proc.returncode != 0:
            # Redact anything shaped like a deploy key before showing the CLI's error.
            detail = re.sub(r"[a-z]+:[a-z0-9-]+\|\S+", "<redacted>", proc.stderr.strip())[-600:]
            raise TemplateError(f"convex deployment token create failed ({proc.returncode}): {detail}")
        value = read_env(key_file).get("CONVEX_DEPLOY_KEY", "")
    if not value.startswith(f"{deployment}|") or UNSAFE.search(value):
        raise TemplateError(f"the created key is not a deploy key for {deployment}; nothing was stored")
    text = keys_path.read_text()
    keys_path.write_text(
        text.rstrip("\n") + f"\n# created by deploy/scripts/server-env.py (Convex deploy key '{name}')\n{var}={value}\n"
    )
    sources[var] = value


def render_all(templates: Path, sources: dict[str, str]) -> tuple[dict[str, bytes], dict[str, list[str]], list[str]]:
    files: dict[str, bytes] = {}
    errors: dict[str, list[str]] = {}
    skipped: list[str] = []
    for path in sorted(templates.glob("*.env")):
        assignments, missing, optional_file = render_template(path, sources)
        if missing:
            if optional_file:
                skipped.append(f"{path.name} (missing {', '.join(missing)})")
                continue
            errors[path.name] = missing
            continue
        files[path.name] = file_content(path.name, assignments)
    return files, errors, skipped


def remote_sh(inner: str) -> str:
    """A command for the remote login shell that runs INNER as root (directly or via sudo -n)."""
    return (
        'if [ "$(id -u)" -eq 0 ]; then S=""; else S="sudo -n"; fi; '
        f"exec $S sh -c {shlex.quote(inner)}"
    )


HASH_INNER = (
    'd="${DESYN_ROOT:-/opt/desyn}/secrets"; [ -d "$d" ] || exit 0; cd "$d" || exit 1; '
    'for f in *.env; do [ -f "$f" ] && sha256sum "$f"; done; exit 0'
)


def write_inner(prune: bool) -> str:
    prune_cmd = " ".join(f'rm -f "$d/{name}";' for name in RETIRED) if prune else ""
    return (
        "set -eu; umask 077; "
        'd="${DESYN_ROOT:-/opt/desyn}/secrets"; mkdir -p "$d"; chmod 0700 "$d"; '
        't="$(mktemp -d "$d/.sync.XXXXXX")"; trap \'rm -rf "$t"\' EXIT; '
        'tar -xf - -C "$t" --no-same-owner --no-same-permissions; '
        'for f in "$t"/*.env; do [ -f "$f" ] || continue; chmod 0600 "$f"; mv -f "$f" "$d/"; done; '
        f"{prune_cmd}"
        'for name in ' + " ".join(RETIRED) + '; do [ -f "$d/$name" ] && echo "retired:$name"; done; exit 0'
    )


def ssh(host: str, command: str, data: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["ssh", *SSH_OPTS, host, command],
        input=data if data is not None else b"",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def remote_hashes(host: str) -> dict[str, str]:
    proc = ssh(host, remote_sh(HASH_INNER))
    if proc.returncode != 0:
        raise TemplateError(f"cannot read the secrets directory on {host}: {proc.stderr.decode(errors='replace')[-300:]}")
    out: dict[str, str] = {}
    for line in proc.stdout.decode().splitlines():
        parts = line.split()
        if len(parts) == 2 and re.fullmatch(r"[0-9a-f]{64}", parts[0]):
            out[parts[1]] = parts[0]
    return out


def tar_bytes(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = 0o600
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(content))
    return buf.getvalue()


def push(host: str, files: dict[str, bytes], prune: bool) -> int:
    before = remote_hashes(host)
    local = {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}
    changed = {name: files[name] for name in files if before.get(name) != local[name]}
    proc = ssh(host, remote_sh(write_inner(prune)), tar_bytes(changed) if changed else tar_bytes({}))
    if proc.returncode != 0:
        print(f"writing the env files on {host} failed: {proc.stderr.decode(errors='replace')[-300:]}", file=sys.stderr)
        return 1
    after = remote_hashes(host)
    status = 0
    for name in sorted(files):
        if after.get(name) != local[name]:
            print(f"  {name:<20} FAILED (content on the server does not match)", file=sys.stderr)
            status = 1
        elif name not in before:
            print(f"  {name:<20} created")
        elif name in changed:
            print(f"  {name:<20} updated")
        else:
            print(f"  {name:<20} unchanged")
    for line in proc.stdout.decode().splitlines():
        if line.startswith("retired:"):
            print(f"  {line[8:]:<20} retired file still present (remove with --prune-retired)")
    return status


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("target", nargs="?")
    parser.add_argument("--host")
    parser.add_argument("--out")
    parser.add_argument("--root")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-create-deploy-key", action="store_true")
    parser.add_argument("--prune-retired", action="store_true")
    parser.add_argument("-h", "--help", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    if args.help:
        print(__doc__)
        return 0
    if unknown or args.target not in TARGETS:
        print(__doc__, file=sys.stderr)
        return 2
    modes = [bool(args.host), bool(args.out), args.check, args.dry_run]
    if sum(modes) != 1:
        print("choose exactly one of --host, --out, --check, --dry-run", file=sys.stderr)
        return 2
    root = Path(args.root).resolve() if args.root else DEFAULT_ROOT
    templates = root / "deploy/env/server"
    if not templates.is_dir():
        print(f"templates not found: {templates}", file=sys.stderr)
        return 2
    sources = load_sources(root)
    deploy_key_var = TARGETS[args.target]["deploy_key_var"]
    try:
        if (args.host or args.out) and not args.no_create_deploy_key:
            ensure_deploy_key(root, args.target, sources)
        files, errors, skipped = render_all(templates, sources)
    except TemplateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    for entry in skipped:
        print(f"  skipped {entry}")
    if errors:
        for name, missing in sorted(errors.items()):
            hint = ""
            if deploy_key_var in missing and (args.check or args.dry_run):
                hint = " (created automatically on the next run with --host, or add it to .env.keys)"
            print(f"  {name:<20} missing {', '.join(missing)}{hint}", file=sys.stderr)
        if not (args.check or args.dry_run):
            print("error: required variables are missing; nothing was written", file=sys.stderr)
            return 1
    if args.check or args.dry_run:
        for name, content in sorted(files.items()):
            keys = [ln.split("=", 1)[0] for ln in content.decode().splitlines() if ln and not ln.startswith("#")]
            detail = ", ".join(keys) if args.dry_run else f"{len(keys)} variables"
            print(f"  {name:<20} {detail}")
        return 1 if errors and args.check else 0
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        os.chmod(out, 0o700)
        for name, content in sorted(files.items()):
            path = out / name
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
            os.chmod(path, 0o600)
            print(f"  {name:<20} written to {path}")
        return 0
    print(f"syncing {len(files)} env files to {args.host}:/opt/desyn/secrets")
    return push(args.host, files, args.prune_retired)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
