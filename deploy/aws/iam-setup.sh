#!/usr/bin/env bash
# Creates the two least-privilege IAM users Desyn needs and writes their access keys straight into
# .env.keys (gitignored) at the repo root. Keys are never printed. Run once as the AWS account owner:
#   bash deploy/aws/iam-setup.sh
# Safe to re-run: users and policies are upserted; a new key is created only when its env entry is empty.
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="$(git rev-parse --show-toplevel)/.env.keys"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }

# Policies name the account as ${AWS_ACCOUNT_ID}; it is filled in from the caller's identity.
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

ensure_user() { # <user> <policy-file>
  aws iam get-user --user-name "$1" >/dev/null 2>&1 ||
    aws iam create-user --user-name "$1" --tags Key=project,Value=desyn >/dev/null
  local policy
  policy="$(sed "s/\${AWS_ACCOUNT_ID}/${AWS_ACCOUNT_ID}/g" "$2")"
  aws iam put-user-policy --user-name "$1" --policy-name "$1-inline" --policy-document "${policy}"
  echo "ok: IAM user $1 with $2"
}

write_key() { # <user> <ID_VAR> <SECRET_VAR>
  if grep -qE "^$2=.+" "$ENV_FILE"; then echo "skip: $2 already set"; return; fi
  aws iam create-access-key --user-name "$1" --output json | python3 -c '
import json, re, sys
k = json.load(sys.stdin)["AccessKey"]
path, idv, secv = sys.argv[1:4]
s = open(path).read()
for name, val in ((idv, k["AccessKeyId"]), (secv, k["SecretAccessKey"])):
    if re.search(rf"^{name}=", s, re.M):
        s = re.sub(rf"^{name}=.*$", lambda _: f"{name}={val}", s, flags=re.M)
    else:
        s = s.rstrip("\n") + f"\n{name}={val}\n"
open(path, "w").write(s)
' "$ENV_FILE" "$2" "$3"
  echo "ok: wrote $2 and $3 to .env.keys (not printed)"
}

ensure_user desyn-app iam-desyn-app.json
ensure_user desyn-backup iam-desyn-backup.json
write_key desyn-app AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
write_key desyn-backup BACKUP_AWS_ACCESS_KEY_ID BACKUP_AWS_SECRET_ACCESS_KEY
