import { runCli } from '@cashu-fault-lab/lab-cli';

declare const CFL_NPM_PACKAGE_VERSION: string;

const outcome = await runCli(process.argv, {
  distribution: 'package',
  version: CFL_NPM_PACKAGE_VERSION,
});
process.exitCode = outcome.exitCode;
