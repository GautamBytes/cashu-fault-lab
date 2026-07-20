#!/bin/bash
# Cashu Fault Lab — one-command local development setup
set -euo pipefail

echo "==> Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "Node.js is required (>=24)"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required (>=11.15.0)"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required"; exit 1; }

echo "==> Creating .env.local from .env.example if needed..."
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "     Created .env.local — edit it with your values if needed"
fi
export $(grep -v '^#' .env.local | xargs)

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

echo "==> Building..."
pnpm build

echo "==> Running checks..."
pnpm format:check
pnpm typecheck
pnpm test

echo ""
echo "Ready. Try these commands:"
echo "  pnpm lab ls"
echo "  pnpm lab run scenarios/retry/response-lost.json --verbose"
echo ""
echo "For the full funded wallet stack:"
echo "  source .env.local"
echo "  docker compose -f infra/compose/wallet-adapters.compose.yml up --build -d --wait"
echo "  pnpm lab matrix --profile delivery-v1 --adapters spec/examples/adapters.local.json"
