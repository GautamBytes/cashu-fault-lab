import { renderJson, renderMatrixJson } from './json.js';
import { createReport, type ReportInput } from './redact.js';
import { createMatrixReport, type MatrixReportInput } from './matrix.js';

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderHtml(input: ReportInput): string {
  const report = createReport(input);
  const statusClass = report.status === 'passed' ? 'passed' : 'failed';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Cashu Fault Lab — ${html(report.scenarioId)}</title>
  <style>
    :root{color-scheme:light dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#101313;color:#e9efec}
    body{max-width:1100px;margin:0 auto;padding:32px 20px}h1{font-size:1.5rem}.status{display:inline-block;padding:4px 9px;border-radius:99px;font-weight:700}.passed{background:#164e33;color:#a7f3d0}.failed{background:#5f1f24;color:#fecaca}pre{overflow:auto;padding:18px;border:1px solid #34403a;border-radius:8px;background:#161b19;line-height:1.45}small{color:#9aaba2}
  </style>
</head>
<body>
  <small>Cashu Fault Lab · schema v1 · seed ${html(report.seed)}</small>
  <h1>${html(report.scenarioId)}</h1>
  <p class="status ${statusClass}">${html(report.status.toUpperCase())}</p>
  <pre>${html(renderJson(input))}</pre>
</body>
</html>
`;
}

const STATUS_CLASS: Readonly<Record<string, string>> = {
  passed: 'passed',
  failed: 'failed',
  not_applicable: 'na',
  expected_failure: 'expected',
};

const STATUS_LABEL: Readonly<Record<string, string>> = {
  passed: 'PASS',
  failed: 'FAIL',
  not_applicable: 'N/A',
  expected_failure: 'EXPECTED FAIL',
};

export function renderMatrixHtml(input: MatrixReportInput): string {
  const report = createMatrixReport(input);
  const rows = report.cases
    .map((result) => {
      const cls = STATUS_CLASS[result.status] ?? 'na';
      const label = STATUS_LABEL[result.status] ?? result.status;
      const detail = result.status === 'passed' ? '' : ` <small>${html(result.reason)}</small>`;
      return `      <tr><td>${html(result.sender)}</td><td>→</td><td>${html(result.receiver)}</td><td class="${cls}">${html(label)}</td><td>${detail}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Cashu Fault Lab — matrix ${html(report.profile)}</title>
  <style>
    :root{color-scheme:light dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#101313;color:#e9efec}
    body{max-width:1100px;margin:0 auto;padding:32px 20px}h1{font-size:1.5rem}table{width:100%;border-collapse:collapse}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #34403a}th{color:#9aaba2}.status{display:inline-block;padding:2px 8px;border-radius:99px;font-weight:700}.passed{background:#164e33;color:#a7f3d0}.failed{background:#5f1f24;color:#fecaca}.na{background:#2a332e;color:#9aaba2}.expected{background:#4a3a1a;color:#fcd9a8}small{color:#9aaba2}
  </style>
</head>
<body>
  <small>Cashu Fault Lab · matrix · profile ${html(report.profile)} · seed ${html(report.seed)}</small>
  <h1>Compatibility matrix</h1>
  <p>
    <span class="status passed">${report.summary.passed} passed</span>
    <span class="status failed">${report.summary.failed} failed</span>
    <span class="status na">${report.summary.notApplicable} N/A</span>
    <span class="status expected">${report.summary.expectedFailure} expected-failure</span>
  </p>
  <table>
    <thead><tr><th>Sender</th><th></th><th>Receiver</th><th>Status</th><th></th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <pre>${html(renderMatrixJson(input))}</pre>
</body>
</html>
`;
}
