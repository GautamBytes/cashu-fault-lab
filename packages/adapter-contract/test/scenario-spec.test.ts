import { describe, expect, it } from 'vitest';
import { validateScenarioSpec } from '../src/index.js';

const validScenario = {
  name: 'http-response-lost',
  description: 'Drops the first HTTP response.',
  commands: [
    {
      type: 'configure_fault',
      target: 'http',
      rule: { kind: 'drop_response', occurrence: 1 },
    },
    { type: 'send', sender: 'reference', requestId: 'AAECAwQFBgcICQoLDA0ODw' },
    { type: 'assert_quiescent' },
  ],
};

describe('validateScenarioSpec', () => {
  it('accepts a well-formed scenario with every command kind', () => {
    expect(
      validateScenarioSpec({
        ...validScenario,
        commands: [
          ...validScenario.commands,
          { type: 'advance_time', milliseconds: 5_000 },
          { type: 'clear_faults', target: 'http' },
          { type: 'restart', component: 'receiver' },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a scenario without a name', () => {
    const result = validateScenarioSpec({ ...validScenario, name: '' });
    expect(result.ok).toBe(false);
  });

  it('rejects a scenario with an empty command array', () => {
    const result = validateScenarioSpec({ ...validScenario, commands: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown top-level field', () => {
    const result = validateScenarioSpec({ ...validScenario, extra: true });
    expect(result).toMatchObject({ ok: false, errorCode: 'SCHEMA_ADDITIONAL_PROPERTY' });
  });

  it('rejects an unknown command type', () => {
    const result = validateScenarioSpec({
      ...validScenario,
      commands: [{ type: 'bogus_command' }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a configure_fault command targeting an unknown transport', () => {
    const result = validateScenarioSpec({
      ...validScenario,
      commands: [{ type: 'configure_fault', target: 'carrier-pigeon', rule: { kind: 'drop' } }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a fault rule with a negative delay', () => {
    const result = validateScenarioSpec({
      ...validScenario,
      commands: [{ type: 'configure_fault', target: 'http', rule: { kind: 'delay', delayMs: -1 } }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a send command missing a requestId', () => {
    const result = validateScenarioSpec({
      ...validScenario,
      commands: [{ type: 'send', sender: 'reference' }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object root', () => {
    expect(validateScenarioSpec('not-a-scenario').ok).toBe(false);
    expect(validateScenarioSpec(null).ok).toBe(false);
    expect(validateScenarioSpec([]).ok).toBe(false);
  });
});
