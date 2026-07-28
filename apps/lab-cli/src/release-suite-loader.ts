import { validateScenarioSpec } from '@cashu-fault-lab/adapter-contract';
import {
  validateReleaseSuite,
  type ReleaseSuite,
  type ReleaseSuiteEntry,
  type ScenarioSpec,
} from '@cashu-fault-lab/scenario-runner';
import { Buffer } from 'node:buffer';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_RELEASE_SUITE_BYTES = 256 * 1024;
const MAX_SCENARIO_BYTES = 256 * 1024;

export interface LoadedReleaseSuiteScenario extends ReleaseSuiteEntry {
  readonly spec: ScenarioSpec;
}

export interface LoadedReleaseSuite extends Omit<ReleaseSuite, 'scenarios'> {
  readonly scenarios: readonly LoadedReleaseSuiteScenario[];
}

export interface ReleaseSuiteLoaderOptions {
  readonly repositoryRoot: string;
  readonly path: string;
  readonly readText: (path: string) => Promise<string>;
  readonly realPath: (path: string) => Promise<string>;
}

function confinedPath(repositoryRoot: string, path: string, subject: string): string {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((component) => component === '..' || component === '.')
  ) {
    throw new Error(`${subject} must be a repository-relative path`);
  }
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, path);
  const fromRoot = relative(root, candidate);
  if (fromRoot.length === 0 || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${subject} must remain inside the repository`);
  }
  return candidate;
}

async function canonicalConfinedPath(
  repositoryRoot: string,
  path: string,
  subject: string,
  realPath: (path: string) => Promise<string>,
): Promise<string> {
  const lexicalCandidate = confinedPath(repositoryRoot, path, subject);
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    [canonicalRoot, canonicalCandidate] = await Promise.all([
      realPath(resolve(repositoryRoot)),
      realPath(lexicalCandidate),
    ]);
  } catch {
    throw new Error(`${subject} was not found`);
  }
  const fromRoot = relative(canonicalRoot, canonicalCandidate);
  if (fromRoot.length === 0 || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${subject} must remain inside the repository`);
  }
  return canonicalCandidate;
}

async function boundedRead(
  readText: (path: string) => Promise<string>,
  path: string,
  maximumBytes: number,
  subject: string,
): Promise<string> {
  let contents: string;
  try {
    contents = await readText(path);
  } catch {
    throw new Error(`${subject} was not found`);
  }
  if (Buffer.byteLength(contents, 'utf8') > maximumBytes) {
    throw new Error(`${subject} exceeds the maximum file size`);
  }
  return contents;
}

function parsedJson(contents: string, subject: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`${subject} is not valid JSON`);
  }
}

function scenarioSpec(value: unknown, path: string): ScenarioSpec {
  const validation = validateScenarioSpec(value);
  if (!validation.ok) {
    throw new Error(
      `Release suite scenario ${path} is invalid: ${validation.errorCode} at ${validation.path || '<root>'}`,
    );
  }
  return value as ScenarioSpec;
}

export async function loadReleaseSuite(
  options: ReleaseSuiteLoaderOptions,
): Promise<LoadedReleaseSuite> {
  const suitePath = await canonicalConfinedPath(
    options.repositoryRoot,
    options.path,
    'Release suite path',
    options.realPath,
  );
  const suiteText = await boundedRead(
    options.readText,
    suitePath,
    MAX_RELEASE_SUITE_BYTES,
    'Release suite',
  );
  const suite = validateReleaseSuite(parsedJson(suiteText, 'Release suite'));
  const scenarios: LoadedReleaseSuiteScenario[] = [];
  for (const entry of suite.scenarios) {
    const path = await canonicalConfinedPath(
      options.repositoryRoot,
      entry.scenario,
      'Release scenario path',
      options.realPath,
    );
    const contents = await boundedRead(
      options.readText,
      path,
      MAX_SCENARIO_BYTES,
      `Release suite scenario ${entry.id}`,
    );
    scenarios.push({
      ...entry,
      spec: scenarioSpec(
        parsedJson(contents, `Release suite scenario ${entry.id}`),
        entry.scenario,
      ),
    });
  }
  return { ...suite, scenarios };
}
