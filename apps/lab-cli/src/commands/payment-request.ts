import type { Command } from 'commander';
import { resolve } from 'node:path';
import type { CliIo } from '../index.js';
import { runPaymentRequestMatrix } from '../payment-request-codecs.js';

export function registerPaymentRequestCommands(
  program: Command,
  io: CliIo,
  setExitCode: (code: 0 | 1 | 2) => void,
): void {
  program
    .command('payment-request')
    .description('Offline NUT-26 codec interoperability')
    .command('matrix')
    .description('Run nut26-bech32m-v1 against cashu-ts and native CDK')
    .requiredOption('--cdk-codec <path>', 'Path to the locally built cdk-payment-request binary')
    .option('--strict', 'Fail for known SDK gaps as well as regressions')
    .option('--output <path>', 'Write JSON evidence, including explicit known SDK gaps')
    .action(async (options: { cdkCodec: string; output?: string; strict?: boolean }) => {
      const report = await runPaymentRequestMatrix(resolve(options.cdkCodec));
      const text = `${JSON.stringify(report, null, 2)}\n`;
      if (options.output) await io.writeText(options.output, text);
      io.stdout(text);
      if (report.regressionGate !== 'passed' || (options.strict && report.conformance !== 'passed'))
        setExitCode(1);
    });
}
