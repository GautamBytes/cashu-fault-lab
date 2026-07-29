import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('developer environment', () => {
  it('pins the Codespaces runtime and isolated Docker daemon', async () => {
    const config = JSON.parse(await readFile('.devcontainer/devcontainer.json', 'utf8'));

    assert.equal(
      config.image,
      'mcr.microsoft.com/devcontainers/typescript-node:5.0.1-24-bookworm',
    );
    assert.deepEqual(config.features, {
      'ghcr.io/devcontainers/features/docker-in-docker:3.0.1': {},
    });
    assert.match(config.postCreateCommand, /corepack enable/u);
    assert.match(config.postCreateCommand, /pnpm install --frozen-lockfile/u);
    assert.deepEqual(config.forwardPorts, [3000]);
    assert.equal(config.remoteUser, 'node');
  });
});
