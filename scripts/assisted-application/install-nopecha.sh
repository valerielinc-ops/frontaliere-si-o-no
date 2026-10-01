#!/usr/bin/env bash
# Official stable automation build; its empty key enables the free IP quota.
set -euo pipefail
target="${1:?usage: install-nopecha.sh <directory>}"
mkdir -p "$target"
gh release download 0.6.1 --repo NopeCHALLC/nopecha-extension \
  --pattern chromium_automation.zip --dir "$target"
(
  cd "$target"
  printf '%s\n' '92ebe154bd34433b4a36e6b2df33006fa6acb19a1b81031a0acb5b72be5e025a  chromium_automation.zip' | shasum -a 256 -c -
  unzip -q chromium_automation.zip -d extension
)
