#!/bin/bash
# Cashu Fault Lab — clean all build artifacts and Docker resources
set -euo pipefail

echo "==> Stopping Docker services..."
docker compose -f infra/compose/wallet-adapters.compose.yml down -v 2>/dev/null || true
docker compose -f infra/compose/nutshell.compose.yml down -v 2>/dev/null || true
docker compose -f infra/compose/lab.compose.yml down -v 2>/dev/null || true

echo "==> Removing build artifacts..."
rm -rf dist/
rm -rf .turbo/
rm -rf adapters/cdk/target/
rm -rf artifacts/
echo "Done. Run 'pnpm install && pnpm build' to rebuild."
