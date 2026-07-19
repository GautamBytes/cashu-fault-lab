#!/usr/bin/env node
import { runCli } from './index.js';

const outcome = await runCli(process.argv);
process.exitCode = outcome.exitCode;
