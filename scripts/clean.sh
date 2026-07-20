#!/bin/bash
# Cashu Fault Lab — clean all build artifacts and Docker resources
set -euo pipefail

echo "==> Stopping Docker services..."
docker compose -f infra/compose/wallet-adapters.compose.yml down -v 2>/dev/null || true
docker compose -f infra/compose/nutshell.compose.yml down -v 2>/dev/null || true
docker compose -f infra/compose/lab.compose.yml down -v 2>/dev/null || true

echo "==> Removing node_modules..."
rm -rf node_modules/

echo "==> Removing all package-level build artifacts..."
find packages apps adapters -maxdepth 2 -name dist -type d -exec rm -rf {} + 2>/dev/null || true
rm -rf dist/

echo "==> Removing Turbo cache..."
rm -rf .turbo/

echo "==> Removing Rust build artifacts..."
rm -rf adapters/cdk/target/

echo "==> Removing scenario artifacts..."
rm -rf artifacts/

echo "Done. Run 'pnpm install && pnpm build' to rebuild."
