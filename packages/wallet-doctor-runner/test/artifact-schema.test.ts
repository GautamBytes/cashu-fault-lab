import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  NIP60_CHECK_ARTIFACT_SCHEMA,
  NIP60_DIAGNOSIS_ARTIFACT_SCHEMA,
  NIP60_REPAIR_PLAN_ARTIFACT_SCHEMA,
  validateNip60CheckArtifact,
} from '../src/index.js';

const cases = [
  ['nip60-diagnosis.schema.json', NIP60_DIAGNOSIS_ARTIFACT_SCHEMA],
  ['nip60-repair-plan.schema.json', NIP60_REPAIR_PLAN_ARTIFACT_SCHEMA],
  ['nip60-check.schema.json', NIP60_CHECK_ARTIFACT_SCHEMA],
] as const;

describe('wallet-doctor artifact schema drift', () => {
  for (const [filename, schema] of cases) {
    it(`${filename} matches the runtime contract`, async () => {
      const url = new URL(`../../../spec/schemas/${filename}`, import.meta.url);
      const committed = JSON.parse(await readFile(url, 'utf8')) as unknown;
      expect(committed).toEqual(JSON.parse(JSON.stringify(schema)));
    });
  }

  it('validates a machine-readable integrity failure with no diagnosis', () => {
    const artifact = {
      schemaVersion: 1,
      kind: 'nip60-check',
      generatedFrom: null,
      ok: false,
      summary: {
        errorFindings: 0,
        warningFindings: 0,
        infoFindings: 0,
        failedRelays: 0,
        codes: [],
        mintVerified: 0,
        merged: 0,
        doubleCounted: 0,
        integrityErrors: ['capture digest does not match its canonical contents'],
      },
      liveVerification: { ok: false, errors: ['live verification skipped'] },
      diagnosis: null,
      plan: null,
    };
    expect(validateNip60CheckArtifact(artifact)).toEqual({ ok: true, errors: [] });
    expect(validateNip60CheckArtifact({ ...artifact, summary: {} }).ok).toBe(false);
  });
});
