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
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="cashu-fault-lab.matrix" tests="${report.summary.total}" failures="${report.summary.failed}" errors="0" skipped="${report.summary.notApplicable + report.summary.expectedFailure}">`,
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
  lines.push('</testsuite>', '');
  return lines.join('\n');
}
