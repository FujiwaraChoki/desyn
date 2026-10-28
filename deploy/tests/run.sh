#!/usr/bin/env bash
# Run every deploy/ test suite. Suites that need something unavailable (nginx binary, unprivileged user
# namespaces) print SKIP instead of failing.
#
# Usage: NGINX_BIN=/usr/sbin/nginx deploy/tests/run.sh
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failed=0
for suite in "${dir}"/*.test.sh; do
  echo "== $(basename "${suite}")"
  if ! bash "${suite}"; then
    failed=1
  fi
done
exit "${failed}"
