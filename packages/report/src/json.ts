import { createReport, type ReportInput } from './redact.js';
import { createMatrixReport, type MatrixReportInput } from './matrix.js';
import { createLifecycleReport, type LifecycleReportInput } from './lifecycle.js';

export function renderJson(input: ReportInput): string {
  return `${JSON.stringify(createReport(input), null, 2)}\n`;
}

export function renderMatrixJson(input: MatrixReportInput): string {
  return `${JSON.stringify(createMatrixReport(input), null, 2)}\n`;
}

export function renderLifecycleJson(input: LifecycleReportInput): string {
  return `${JSON.stringify(createLifecycleReport(input), null, 2)}\n`;
}
