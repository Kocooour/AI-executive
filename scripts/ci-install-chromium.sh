#!/usr/bin/env bash
set -euo pipefail

# GitHub-hosted ubuntu-24.04 runners normally include Chromium's shared
# libraries. Avoid apt on every job: temporary Ubuntu mirror 503s must not
# prevent browser tests from starting.
pnpm exec playwright install chromium

check_chromium() {
  node --input-type=module <<'NODE'
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
await browser.close();
NODE
}

if check_chromium; then
  echo 'Playwright Chromium launched with preinstalled system dependencies.'
  exit 0
fi

# If the runner lacks libraries, install them without weakening the browser
# gate. Retry only this dependency-install fallback on transient apt failures.
echo '::warning::Chromium cannot launch with runner libraries; installing Linux dependencies.'
for attempt in 1 2 3; do
  echo "Installing Chromium Linux dependencies (attempt ${attempt}/3)..."
  if pnpm exec playwright install --with-deps chromium && check_chromium; then
    exit 0
  fi
  if (( attempt < 3 )); then
    sleep $((attempt * 15))
  fi
done

echo '::error::Playwright Chromium installation or launch failed after 3 dependency-install attempts.'
exit 1
