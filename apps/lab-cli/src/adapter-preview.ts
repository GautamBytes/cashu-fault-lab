import { renderMatrixHtml, renderMatrixJson, renderMatrixJunit } from '@cashu-fault-lab/report';
import type { MatrixCaseResult } from '@cashu-fault-lab/scenario-runner';
import type { AdapterPreflightReport } from './adapter-preflight.js';

export interface AdapterPreviewScenario {
  readonly id: string;
  readonly path: string;
  readonly seed: string;
}

export interface AdapterPreviewRuntime {
  readonly node: string;
  readonly platform: string;
  readonly architecture: string;
}

export interface AdapterPreviewArtifactInput {
  readonly profile: string;
  readonly seed: string;
  readonly sender: string;
  readonly receiver: string;
  readonly preflight: AdapterPreflightReport;
  readonly result: MatrixCaseResult;
  readonly cliVersion: string;
  readonly runtime: AdapterPreviewRuntime;
  readonly scenarios: readonly AdapterPreviewScenario[];
}

export interface LocalFaultGatewayConfiguration {
  readonly url: string;
  readonly token: string;
}

export function validateLocalFaultGateway(
  env: Readonly<Record<string, string | undefined>>,
): LocalFaultGatewayConfiguration {
  const value = env.CFL_HTTP_FAULT_GATEWAY_URL;
  const token = env.CFL_HTTP_FAULT_GATEWAY_TOKEN;
  if (
    value === undefined ||
    token === undefined ||
    token.trim().length === 0 ||
    /[\r\n]/u.test(token)
  ) {
    throw new Error(
      'FAULT_GATEWAY_REQUIRED: set CFL_HTTP_FAULT_GATEWAY_URL and CFL_HTTP_FAULT_GATEWAY_TOKEN',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'FAULT_GATEWAY_NOT_LOOPBACK: CFL_HTTP_FAULT_GATEWAY_URL must be an origin-only loopback HTTP URL',
    );
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
    url.port.length === 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new Error(
      'FAULT_GATEWAY_NOT_LOOPBACK: CFL_HTTP_FAULT_GATEWAY_URL must be an origin-only loopback HTTP URL',
    );
  }
  return { url: url.origin, token };
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9._/:=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function rerunCommand(
  scenario: AdapterPreviewScenario,
  input: AdapterPreviewArtifactInput,
): string {
  return [
    'cashu-fault-lab run',
    shellArgument(scenario.path),
    '--seed',
    shellArgument(scenario.seed),
    '--adapters adapter-manifest.json',
    '--sender',
    shellArgument(input.sender),
    '--receiver',
    shellArgument(input.receiver),
  ].join(' ');
}

function readme(input: AdapterPreviewArtifactInput): string {
  const lines = [
    'Cashu Fault Lab maintainer preview',
    '',
    'This result is developer feedback evidence. It is not release qualification or certification.',
    '',
    `Pair: ${input.sender} -> ${input.receiver}`,
    `Profile: ${input.profile}`,
    `Seed: ${input.seed}`,
    `Status: ${input.result.status}`,
    '',
    'Rerun individual scenarios:',
    ...input.scenarios.map((scenario) => `- ${rerunCommand(scenario, input)}`),
    '',
    'Share preview.json for machine-readable diagnostics or preview.html for human review.',
    'Do not attach raw wallet logs, proofs, private keys, or bearer tokens.',
    '',
  ];
  return lines.join('\n');
}

function previewHtml(matrixInput: {
  readonly profile: string;
  readonly seed: string;
  readonly results: readonly MatrixCaseResult[];
}): string {
  return renderMatrixHtml(matrixInput).replace(
    '<body>',
    '<body>\n  <p><strong>Maintainer preview:</strong> developer feedback evidence, not release qualification or certification.</p>',
  );
}

export function createAdapterPreviewArtifacts(
  input: AdapterPreviewArtifactInput,
): ReadonlyMap<string, string> {
  const matrixInput = {
    profile: input.profile,
    seed: input.seed,
    results: [input.result],
  };
  const matrix = JSON.parse(renderMatrixJson(matrixInput)) as unknown;
  const preview = {
    schemaVersion: 1,
    kind: 'cashu-fault-lab-maintainer-preview',
    qualification: false,
    cliVersion: input.cliVersion,
    runtime: input.runtime,
    pair: { sender: input.sender, receiver: input.receiver },
    preflight: input.preflight,
    matrix,
    rerun: input.scenarios.map((scenario) => ({
      id: scenario.id,
      command: rerunCommand(scenario, input),
    })),
  };
  return new Map([
    ['preflight.json', `${JSON.stringify(input.preflight, null, 2)}\n`],
    ['preview.json', `${JSON.stringify(preview, null, 2)}\n`],
    ['preview.html', previewHtml(matrixInput)],
    ['preview.junit.xml', renderMatrixJunit(matrixInput)],
    ['README.txt', readme(input)],
  ]);
}
