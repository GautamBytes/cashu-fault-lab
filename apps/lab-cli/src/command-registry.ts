export interface CliArgumentDefinition {
  readonly value: string;
  readonly description: string;
}

export interface CliOptionDefinition {
  readonly flags: string;
  readonly description: string;
  readonly defaultValue?: string;
  readonly choices?: readonly string[];
}

export interface CliExitCodeDefinition {
  readonly code: 0 | 1 | 2;
  readonly meaning: string;
}

export interface CliCommandDefinition {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  readonly arguments: readonly CliArgumentDefinition[];
  readonly options: readonly CliOptionDefinition[];
  readonly examples: readonly string[];
  readonly env: readonly string[];
  readonly modes: readonly string[];
  readonly artifacts: readonly string[];
  readonly exitCodes: readonly CliExitCodeDefinition[];
}

const COMMON_EXIT_CODES: readonly CliExitCodeDefinition[] = [
  { code: 0, meaning: 'Command completed successfully.' },
  { code: 1, meaning: 'The lab operation completed with a failed scenario or gate.' },
  { code: 2, meaning: 'Command input, configuration, or environment was invalid.' },
];

export function createCommandRegistry(): readonly CliCommandDefinition[] {
  return [
    {
      name: 'up',
      usage: 'cashu-fault-lab up',
      summary: 'Start the local lab services',
      arguments: [],
      options: [
        { flags: '--profile <profile>', description: 'Compose profile.', defaultValue: 'lab' },
      ],
      examples: ['cashu-fault-lab up --profile lab'],
      env: [],
      modes: ['text'],
      artifacts: ['.cashu-fault-lab/runtime/reference/secrets.env'],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'down',
      usage: 'cashu-fault-lab down',
      summary: 'Stop the local lab services',
      arguments: [],
      options: [
        { flags: '--profile <profile>', description: 'Compose profile.', defaultValue: 'lab' },
      ],
      examples: ['cashu-fault-lab down --profile lab'],
      env: [],
      modes: ['text'],
      artifacts: [],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'adapter init',
      usage: 'cashu-fault-lab adapter init --language <language> --name <name>',
      summary: 'Scaffold a standalone wallet adapter project',
      arguments: [],
      options: [
        {
          flags: '--language <language>',
          description: 'Template language.',
          choices: ['typescript', 'rust', 'python'],
        },
        { flags: '--name <name>', description: 'Adapter project name.' },
        {
          flags: '--role <role>',
          description: 'Adapter role.',
          defaultValue: 'both',
          choices: ['sender', 'receiver', 'both'],
        },
        { flags: '--output <path>', description: 'Output directory.', defaultValue: '<name>' },
      ],
      examples: [
        'cashu-fault-lab adapter init --language rust --name my-wallet',
        'cashu-fault-lab adapter init --language python --name receive-only --role receiver --output ./receive-only',
      ],
      env: [],
      modes: ['text'],
      artifacts: [
        '<output>/adapter-manifest.json',
        '<output>/Dockerfile',
        '<output>/.github/workflows/ci.yml',
      ],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'demo',
      usage: 'cashu-fault-lab demo',
      summary: 'Run the response-loss recovery demo against the reference stack',
      arguments: [],
      options: [
        { flags: '--keep', description: 'Leave a stack started by this command running.' },
        {
          flags: '--seed <seed>',
          description: 'Deterministic demo seed.',
          defaultValue: 'cashu-fault-lab-v0.1.0-demo',
        },
        { flags: '--artifact <path>', description: 'Write JSON evidence to this path.' },
        { flags: '--report <path>', description: 'Write HTML report to this path.' },
      ],
      examples: [
        'cashu-fault-lab demo',
        'cashu-fault-lab demo --seed cashu-fault-lab-v0.1.0-demo --artifact docs/examples/v0.1.0-demo.json --report docs/examples/v0.1.0-demo.html',
      ],
      env: [],
      modes: ['text'],
      artifacts: [
        '.cashu-fault-lab/runtime/reference/reports/demo.json',
        '.cashu-fault-lab/runtime/reference/reports/demo.html',
      ],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'run',
      usage: 'cashu-fault-lab run <scenario>',
      summary: 'Run one scenario',
      arguments: [
        {
          value: '<scenario>',
          description: 'scenario JSON file path or packaged shorthand.',
        },
      ],
      options: [
        {
          flags: '--seed <seed>',
          description: 'Deterministic seed.',
          defaultValue: 'cashu-fault-lab',
        },
        { flags: '--artifact <path>', description: 'Write replayable result artifact.' },
        {
          flags: '--sender <adapter>',
          description: 'Sender adapter.',
          defaultValue: 'reference-ts',
        },
        {
          flags: '--receiver <adapter>',
          description: 'Receiver adapter.',
          defaultValue: 'reference-ts',
        },
        { flags: '--adapters <path>', description: 'External adapter manifest.' },
        { flags: '--verbose', description: 'Print progress for each command.' },
      ],
      examples: [
        'cashu-fault-lab run retry/response-lost --seed demo',
        'cashu-fault-lab run scenarios/retry/response-lost.json --artifact artifacts/run.json',
      ],
      env: ['CFL_CASHU_TS_TOKEN', 'CFL_CDK_TOKEN', 'CFL_REFERENCE_RECEIVER_TOKEN'],
      modes: ['text'],
      artifacts: ['artifacts/latest.json'],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'replay',
      usage: 'cashu-fault-lab replay <artifact>',
      summary: 'Replay a deterministic failure artifact',
      arguments: [{ value: '<artifact>', description: 'Artifact JSON file.' }],
      options: [
        { flags: '--artifact <path>', description: 'Write the new result artifact.' },
        { flags: '--verbose', description: 'Print progress for each command.' },
      ],
      examples: ['cashu-fault-lab replay artifacts/latest.json'],
      env: [],
      modes: ['text'],
      artifacts: [],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'shrink',
      usage: 'cashu-fault-lab shrink <artifact>',
      summary: 'Minimize a failing artifact to the smallest reproducing command set',
      arguments: [{ value: '<artifact>', description: 'Artifact JSON file.' }],
      options: [
        { flags: '--artifact <path>', description: 'Write the minimized result artifact.' },
        {
          flags: '--run-limit <count>',
          description: 'Maximum shrink probe runs.',
          defaultValue: '100',
        },
        { flags: '--verbose', description: 'Print minimization progress.' },
      ],
      examples: ['cashu-fault-lab shrink artifacts/latest.json --run-limit 50'],
      env: [],
      modes: ['text'],
      artifacts: [],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'diff',
      usage: 'cashu-fault-lab diff <left> <right>',
      summary: 'Compare two scenario result artifacts and print the structured differences',
      arguments: [
        { value: '<left>', description: 'Left baseline artifact JSON file.' },
        { value: '<right>', description: 'Right candidate artifact JSON file.' },
      ],
      options: [{ flags: '--json', description: 'Emit machine-readable JSON instead of text.' }],
      examples: ['cashu-fault-lab diff artifacts/baseline.json artifacts/candidate.json --json'],
      env: [],
      modes: ['text', 'json'],
      artifacts: [],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'matrix',
      usage: 'cashu-fault-lab matrix',
      summary: 'Run the sender/receiver compatibility matrix',
      arguments: [],
      options: [
        {
          flags: '--profile <profile>',
          description: 'Matrix profile.',
          defaultValue: 'delivery-v1',
        },
        {
          flags: '--seed <seed>',
          description: 'Deterministic seed.',
          defaultValue: 'cashu-fault-lab',
        },
        { flags: '--min-passes <count>', description: 'Minimum passing pairs required.' },
        { flags: '--release-policy <path>', description: 'Release policy JSON file.' },
        { flags: '--release-suite <path>', description: 'Release scenario suite JSON file.' },
        { flags: '--adapters <path>', description: 'External adapter manifest.' },
        {
          flags: '--format <format>',
          description: 'Report format for full matrix output.',
          defaultValue: 'text',
          choices: ['text', 'json', 'junit', 'html'],
        },
        { flags: '--output <path>', description: 'Write the formatted matrix report to a file.' },
        { flags: '--verbose', description: 'Print per-pair results.' },
      ],
      examples: [
        'cashu-fault-lab matrix --profile delivery-v1',
        'cashu-fault-lab matrix --profile delivery-v1 --format html --output artifacts/matrix.html',
      ],
      env: ['CFL_CASHU_TS_TOKEN', 'CFL_CDK_TOKEN', 'CFL_REFERENCE_RECEIVER_TOKEN'],
      modes: ['text', 'json', 'junit', 'html'],
      artifacts: [],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'report',
      usage: 'cashu-fault-lab report [artifact]',
      summary: 'Render a redacted scenario report',
      arguments: [{ value: '[artifact]', description: 'Scenario result JSON file.' }],
      options: [
        {
          flags: '--format <format>',
          description: 'Report format.',
          defaultValue: 'json',
          choices: ['json', 'junit', 'html'],
        },
        { flags: '--output <path>', description: 'Write report to a file.' },
      ],
      examples: ['cashu-fault-lab report artifacts/latest.json --format html --output report.html'],
      env: [],
      modes: ['json', 'junit', 'html'],
      artifacts: [],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'ls',
      usage: 'cashu-fault-lab ls',
      summary: 'List all available scenarios',
      arguments: [],
      options: [{ flags: '--json', description: 'Output JSON.' }],
      examples: ['cashu-fault-lab ls --json'],
      env: [],
      modes: ['text', 'json'],
      artifacts: [],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'inspect',
      usage: 'cashu-fault-lab inspect <scenario>',
      summary: 'Pretty-print a scenario file',
      arguments: [{ value: '<scenario>', description: 'Scenario JSON file path or shorthand.' }],
      options: [],
      examples: ['cashu-fault-lab inspect retry/response-lost'],
      env: [],
      modes: ['json'],
      artifacts: [],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'validate',
      usage: 'cashu-fault-lab validate <scenario>',
      summary: 'Validate a scenario file against the scenario-spec schema',
      arguments: [{ value: '<scenario>', description: 'Scenario JSON file path or shorthand.' }],
      options: [],
      examples: ['cashu-fault-lab validate retry/response-lost'],
      env: [],
      modes: ['text'],
      artifacts: [],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'gen-id',
      usage: 'cashu-fault-lab gen-id',
      summary: 'Generate a random 128-bit ProtocolId',
      arguments: [],
      options: [],
      examples: ['cashu-fault-lab gen-id'],
      env: [],
      modes: ['text'],
      artifacts: [],
      exitCodes: COMMON_EXIT_CODES,
    },
    {
      name: 'doctor',
      usage: 'cashu-fault-lab doctor',
      summary: 'Check local prerequisites (env, tools, ports) for funded lab lanes',
      arguments: [],
      options: [{ flags: '--json', description: 'Emit machine-readable JSON instead of text.' }],
      examples: ['cashu-fault-lab doctor', 'cashu-fault-lab doctor --json'],
      env: [
        'CFL_REAL_MINT_URL',
        'CFL_CASHU_TS_TOKEN',
        'CFL_CDK_TOKEN',
        'CFL_REFERENCE_RECEIVER_TOKEN',
        'CFL_REFERENCE_RECEIVER_CLAIM_KEY',
        'CFL_HTTP_FAULT_GATEWAY_TOKEN',
      ],
      modes: ['text', 'json'],
      artifacts: [],
      exitCodes: COMMON_EXIT_CODES,
    },
  ];
}
