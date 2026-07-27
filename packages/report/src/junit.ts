import { renderJson } from './json.js';
import { createReport, type ReportInput } from './redact.js';
import { createMatrixReport, type MatrixReportInput } from './matrix.js';

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

export function renderMatrixJunit(input: MatrixReportInput): string {
  const report = createMatrixReport(input);
  const gateFailed = report.releaseGate !== undefined && !report.releaseGate.passed;
  const gateTests = report.releaseGate === undefined ? 0 : 1;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="cashu-fault-lab.matrix" tests="${report.summary.total + gateTests}" failures="${report.summary.failed + (gateFailed ? 1 : 0)}" errors="0" skipped="${report.summary.notApplicable + report.summary.expectedFailure}">`,
  ];
  for (const result of report.cases) {
    const classname = `cashu-fault-lab.matrix.${xml(report.profile)}`;
    const name = `${xml(result.sender)}->${xml(result.receiver)}`;
    if (result.status === 'failed') {
      lines.push(
        `  <testcase classname="${classname}" name="${name}"><failure type="${xml(result.code)}" message="${xml(result.reason)}"/></testcase>`,
      );
    } else if (result.status === 'expected_failure') {
      lines.push(
        `  <testcase classname="${classname}" name="${name}"><skipped type="${xml(result.code)}" message="${xml(result.reason)}"/></testcase>`,
      );
    } else if (result.status === 'not_applicable') {
      lines.push(
        `  <testcase classname="${classname}" name="${name}"><skipped message="${xml(result.reason)}"/></testcase>`,
      );
    } else {
      lines.push(`  <testcase classname="${classname}" name="${name}"/>`);
    }
  }
  if (report.releaseGate !== undefined) {
    if (report.releaseGate.passed) {
      lines.push('  <testcase classname="cashu-fault-lab.release" name="release-policy"/>');
    } else {
      const message = report.releaseGate.reasons
        .map((reason) => `${reason.code}: ${reason.message}`)
        .join('; ');
      lines.push(
        `  <testcase classname="cashu-fault-lab.release" name="release-policy"><failure type="RELEASE_GATE_FAILED" message="${xml(message)}"/></testcase>`,
      );
    }
  }
  lines.push('</testsuite>', '');
  return lines.join('\n');
}
