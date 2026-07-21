import type { MatrixCaseResult } from '@cashu-fault-lab/scenario-runner';

export interface MatrixReportInput {
  readonly profile: string;
  readonly seed: string;
  readonly results: readonly MatrixCaseResult[];
}

export interface MatrixReportDocument {
  readonly schemaVersion: 1;
  readonly profile: string;
  readonly seed: string;
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly notApplicable: number;
    readonly expectedFailure: number;
    readonly total: number;
  };
  readonly cases: readonly MatrixCaseResult[];
}

export function createMatrixReport(input: MatrixReportInput): MatrixReportDocument {
  const passed = input.results.filter((result) => result.status === 'passed').length;
  const failed = input.results.filter((result) => result.status === 'failed').length;
  const notApplicable = input.results.filter((result) => result.status === 'not_applicable').length;
  const expectedFailure = input.results.filter(
    (result) => result.status === 'expected_failure',
  ).length;
  return {
    schemaVersion: 1,
    profile: input.profile,
    seed: input.seed,
    summary: {
      passed,
      failed,
      notApplicable,
      expectedFailure,
      total: input.results.length,
    },
    cases: [...input.results],
  };
}
