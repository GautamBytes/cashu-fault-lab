import { runCli } from '@cashu-fault-lab/lab-cli';

const outcome = await runCli(process.argv, { distribution: 'package' });
process.exitCode = outcome.exitCode;
