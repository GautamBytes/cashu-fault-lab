import { createReport, type ReportInput } from './redact.js';

export function renderJson(input: ReportInput): string {
  return `${JSON.stringify(createReport(input), null, 2)}\n`;
}
