import { renderJson } from './json.js';
import { createReport, type ReportInput } from './redact.js';

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderJunit(input: ReportInput): string {
  const report = createReport(input);
  const failed = report.status === 'failed';
  const failure = failed
    ? `<failure type="${xml(report.failure?.code ?? 'SCENARIO_EXECUTION_FAILED')}" message="${xml(report.failure?.message ?? 'Scenario execution failed.')}"/>`
    : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="cashu-fault-lab" tests="1" failures="${failed ? 1 : 0}" errors="0" skipped="0">`,
    `<testcase classname="cashu-fault-lab.scenario" name="${xml(report.scenarioId)}">${failure}<system-out>${xml(renderJson(input))}</system-out></testcase>`,
    '</testsuite>',
    '',
  ].join('\n');
}
