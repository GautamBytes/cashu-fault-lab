import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const runtime = fileURLToPath(new URL('../runtime/', import.meta.url));
const license = fileURLToPath(new URL('../LICENSE', import.meta.url));
const packageManifest = JSON.parse(await readFile(`${packageRoot}/package.json`, 'utf8'));
const packageVersion = packageManifest.version;

if (
  typeof packageVersion !== 'string' ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion)
) {
  throw new Error('The npm package version must be a valid semantic version');
}

await Promise.all([
  rm(dist, { recursive: true, force: true }),
  rm(runtime, { recursive: true, force: true }),
  rm(license, { force: true }),
]);
await Promise.all([
  mkdir(dist, { recursive: true }),
  mkdir(`${runtime}/compose`, { recursive: true }),
]);

await build({
  entryPoints: [`${packageRoot}/src/bin.ts`],
  outfile: `${dist}/bin.js`,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  bundle: true,
  sourcemap: false,
  legalComments: 'eof',
  define: {
    CFL_NPM_PACKAGE_VERSION: JSON.stringify(packageVersion),
  },
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
await chmod(`${dist}/bin.js`, 0o755);

await Promise.all([
  cp(`${repositoryRoot}/LICENSE`, license),
  cp(`${repositoryRoot}/scenarios`, `${runtime}/scenarios`, { recursive: true }),
  cp(
    `${repositoryRoot}/infra/compose/nutshell.compose.yml`,
    `${runtime}/compose/nutshell.compose.yml`,
  ),
  cp(`${repositoryRoot}/infra/compose/lab.compose.yml`, `${runtime}/compose/lab.compose.yml`),
  cp(
    `${repositoryRoot}/infra/compose/cdk-mint.compose.yml`,
    `${runtime}/compose/cdk-mint.compose.yml`,
  ),
  cp(`${repositoryRoot}/spec`, `${runtime}/spec`, { recursive: true }),
]);

const runtimeComposeTemplate = await readFile(
  `${repositoryRoot}/infra/compose/npm-runtime.compose.yml`,
  'utf8',
);
const versionToken = '__CFL_PACKAGE_VERSION__';
if (!runtimeComposeTemplate.includes(versionToken)) {
  throw new Error(`The npm runtime Compose template must include ${versionToken}`);
}
await writeFile(
  `${runtime}/compose/wallet-adapters.compose.yml`,
  runtimeComposeTemplate.replaceAll(versionToken, packageVersion),
);
