import { createReport, type ReportInput } from './redact.js';
import { createMatrixReport, type MatrixReportInput } from './matrix.js';

export function renderJson(input: ReportInput): string {
  return `${JSON.stringify(createReport(input), null, 2)}\n`;
}

export function renderMatrixJson(input: MatrixReportInput): string {
  return `${JSON.stringify(createMatrixReport(input), null, 2)}\n`;
}
