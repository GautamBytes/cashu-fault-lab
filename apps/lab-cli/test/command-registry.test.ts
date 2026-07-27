import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCommandRegistry } from '../src/command-registry.js';

describe('CLI command registry', () => {
  it('describes commands with operational metadata used for generated docs', () => {
    const registry = createCommandRegistry();
    const byName = new Map(registry.map((command) => [command.name, command]));

    expect([...byName.keys()]).toEqual([
      'up',
      'down',
      'adapter init',
      'demo',
      'run',
      'replay',
      'shrink',
      'diff',
      'matrix',
      'report',
      'ls',
      'inspect',
      'validate',
      'gen-id',
      'doctor',
    ]);

    expect(byName.get('run')).toMatchObject({
      summary: 'Run one scenario',
      arguments: [{ value: '<scenario>', description: expect.stringContaining('scenario') }],
      options: expect.arrayContaining([
        expect.objectContaining({ flags: '--seed <seed>' }),
        expect.objectContaining({ flags: '--artifact <path>' }),
        expect.objectContaining({ flags: '--adapters <path>' }),
      ]),
      examples: expect.arrayContaining([
        expect.stringContaining('cashu-fault-lab run retry/response-lost'),
      ]),
      artifacts: expect.arrayContaining(['artifacts/latest.json']),
      exitCodes: expect.arrayContaining([
        expect.objectContaining({ code: 0 }),
        expect.objectContaining({ code: 1 }),
        expect.objectContaining({ code: 2 }),
      ]),
    });

    expect(byName.get('adapter init')).toMatchObject({
      usage: 'cashu-fault-lab adapter init --language <language> --name <name>',
      options: expect.arrayContaining([
        expect.objectContaining({
          flags: '--language <language>',
          choices: ['typescript', 'rust', 'python'],
        }),
        expect.objectContaining({
          flags: '--role <role>',
          choices: ['sender', 'receiver', 'both'],
        }),
        expect.objectContaining({ flags: '--output <path>' }),
      ]),
      artifacts: expect.arrayContaining(['<output>/adapter-manifest.json', '<output>/Dockerfile']),
    });

    expect(byName.get('demo')).toMatchObject({
      summary: 'Run the response-loss recovery demo against the reference stack',
      options: expect.arrayContaining([
        expect.objectContaining({ flags: '--keep' }),
        expect.objectContaining({ flags: '--artifact <path>' }),
        expect.objectContaining({ flags: '--report <path>' }),
      ]),
      artifacts: expect.arrayContaining([
        '.cashu-fault-lab/runtime/reference/reports/demo.json',
        '.cashu-fault-lab/runtime/reference/reports/demo.html',
      ]),
    });

    expect(byName.get('doctor')).toMatchObject({
      env: expect.arrayContaining(['CFL_REAL_MINT_URL']),
      modes: expect.arrayContaining(['text', 'json']),
    });
  });

  it('keeps the generated CLI reference in sync with the registry', async () => {
    const docsPath = fileURLToPath(new URL('../../../docs/cli-reference.md', import.meta.url));
    const docs = await readFile(docsPath, 'utf8');

    expect(docs).toContain('## `cashu-fault-lab run <scenario>`');
    expect(docs).toContain('Artifacts: `artifacts/latest.json`');
    expect(docs).toContain('## `cashu-fault-lab adapter init --language <language> --name <name>`');
    expect(docs).toContain('## `cashu-fault-lab demo`');
    expect(docs).toContain('## `cashu-fault-lab doctor`');
    expect(docs).toContain('Environment: `CFL_REAL_MINT_URL`');
  });
});
