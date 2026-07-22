import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workflows = [
  '.github/workflows/ci.yml',
  '.github/workflows/nightly.yml',
  '.github/workflows/weekly.yml',
  '.github/workflows/release.yml',
] as const;

const realMints = [
  {
    name: 'Nutshell',
    composeFile: 'infra/compose/nutshell.compose.yml',
    url: 'http://127.0.0.1:3338',
  },
  {
    name: 'CDK',
    composeFile: 'infra/compose/cdk-mint.compose.yml',
    url: 'http://127.0.0.1:8085',
  },
] as const;

describe('real-mint workflow lanes', () => {
  it.each(workflows)(
    '%s runs the funded cross-language lane against both pinned mints',
    async (workflow) => {
      const contents = await readFile(new URL(`../../../${workflow}`, import.meta.url), 'utf8');

      for (const mint of realMints) {
        expect(contents, `${workflow} should include ${mint.name} compose file`).toContain(
          mint.composeFile,
        );
        expect(contents, `${workflow} should include ${mint.name} URL`).toContain(mint.url);
      }
      expect(contents).toContain('test/cross-language-docker.test.ts');
    },
  );
});
