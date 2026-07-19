import { renderJson } from './json.js';
import { createReport, type ReportInput } from './redact.js';

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
