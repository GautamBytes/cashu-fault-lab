import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('developer environment', () => {
  it('pins the Codespaces runtime and isolated Docker daemon', async () => {
    const [config, lock] = await Promise.all([
      readFile('.devcontainer/devcontainer.json', 'utf8').then(JSON.parse),
      readFile('.devcontainer/devcontainer-lock.json', 'utf8').then(JSON.parse),
    ]);

    assert.equal(config.image, 'mcr.microsoft.com/devcontainers/typescript-node:5.0.1-24-bookworm');
    assert.deepEqual(config.features, {
      'ghcr.io/devcontainers/features/node:2.1.0': {
        nodeGypDependencies: false,
        npmVersion: 'none',
        pnpmVersion: '11.15.0',
        version: 'none',
      },
      'ghcr.io/devcontainers/features/docker-in-docker:3.0.1': {},
    });
    assert.doesNotMatch(config.postCreateCommand, /corepack enable/u);
    assert.match(config.postCreateCommand, /&& CI=true corepack /u);
    assert.match(config.postCreateCommand, /pnpm install --frozen-lockfile/u);
    assert.deepEqual(config.mounts, [
      'source=${localWorkspaceFolderBasename}-node-modules,target=${containerWorkspaceFolder}/node_modules,type=volume',
      'source=${localWorkspaceFolderBasename}-pnpm-store,target=/home/node/.local/share/pnpm/store,type=volume',
    ]);
    assert.match(
      config.postCreateCommand,
      /^sudo chown -R node:node node_modules \/home\/node\/\.local\/share\/pnpm\/store && /u,
    );
    assert.deepEqual(config.forwardPorts, [3000]);
    assert.equal(config.remoteUser, 'node');
    assert.deepEqual(Object.keys(lock.features).sort(), Object.keys(config.features).sort());
    for (const feature of Object.values(lock.features)) {
      assert.match(feature.resolved, /@sha256:[a-f0-9]{64}$/u);
      assert.equal(feature.integrity, feature.resolved.slice(feature.resolved.indexOf('sha256:')));
    }
  });

  it('documents the same Codespaces and local quickstart paths', async () => {
    const [gitignore, readme] = await Promise.all([
      readFile('.gitignore', 'utf8'),
      readFile('README.md', 'utf8'),
    ]);

    assert.match(gitignore, /^\.pnpm-store\/$/mu);
    assert.match(readme, /https:\/\/codespaces\.new\/GautamBytes\/cashu-fault-lab\?quickstart=1/u);
    assert.match(readme, /\.\/scripts\/quickstart\n/u);
    assert.match(readme, /\.\/scripts\/quickstart --check/u);
    assert.match(readme, /experimental v0\.2 developer preview/u);
  });

  it('keeps the portal toolchain portable and exercises user entry paths in CI', async () => {
    const [ci, contributing, playwright, tsconfig] = await Promise.all([
      readFile('.github/workflows/ci.yml', 'utf8'),
      readFile('CONTRIBUTING.md', 'utf8'),
      readFile('apps/website/playwright.config.ts', 'utf8'),
      readFile('apps/website/tsconfig.json', 'utf8').then(JSON.parse),
    ]);

    assert.equal(tsconfig.extends, '../../tsconfig.base.json');
    assert.doesNotMatch(playwright, /\/Users\//u);
    assert.match(
      playwright,
      /command:\s*'corepack pnpm build && corepack pnpm start --port 4317'/u,
    );
    assert.match(contributing, /Next\.js website uses bundler-resolved extensionless imports/u);
    assert.match(
      ci,
      /pnpm --filter @cashu-fault-lab\/website exec playwright install --with-deps chromium/u,
    );
    assert.match(ci, /pnpm website:test:e2e/u);
    assert.match(ci, /\.\/scripts\/quickstart --skip-install/u);
    assert.match(ci, /@devcontainers\/cli@0\.88\.0 up --workspace-folder \./u);
    assert.match(
      ci,
      /@devcontainers\/cli@0\.88\.0 exec --workspace-folder \. \.\/scripts\/quickstart --skip-install/u,
    );
  });
});
