import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { resolveRepositoryPath, sourceUrl } from './repository';

export interface ScenarioCard {
  slug: string;
  name: string;
  description: string;
  family: string;
  commandCount: number;
  sourceUrl: string;
}

export interface ScenarioGroup {
  family: string;
  scenarios: ScenarioCard[];
}

interface ScenarioSourceLocation {
  family: string;
  slug: string;
  sourcePath: string;
}

export function scenarioSourceLocation(relativePath: string): ScenarioSourceLocation {
  const pathSegments = relativePath.split('/');
  const family = pathSegments.length > 1 ? pathSegments[0] : undefined;

  if (!family) {
    throw new Error(
      `Scenario scenarios/${relativePath} must belong to a top-level family directory`,
    );
  }

  return {
    family,
    slug: relativePath.replace(/\.json$/, ''),
    sourcePath: `scenarios/${relativePath}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  scenario: Record<string, unknown>,
  key: 'name' | 'description',
  sourcePath: string,
): string {
  const value = scenario[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Scenario ${sourcePath} must contain a non-empty ${key}`);
  }

  return value;
}

function scenarioDisplayName(scenario: Record<string, unknown>, sourcePath: string): string {
  const name = scenario.name;
  if (typeof name === 'string' && name.trim() !== '') return name;

  const id = scenario.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`Scenario ${sourcePath} must contain a non-empty name or valid id`);
  }

  return id
    .split('-')
    .map((word, index) => (index === 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word))
    .join(' ');
}

async function discoverJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return discoverJsonFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.json') ? [entryPath] : [];
    }),
  );

  return paths.flat();
}

async function parseScenario(scenariosRoot: string, filePath: string): Promise<ScenarioCard> {
  const relativePath = relative(scenariosRoot, filePath).split(sep).join('/');
  const location = scenarioSourceLocation(relativePath);
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));

  if (!isRecord(parsed)) {
    throw new Error(`Scenario ${location.sourcePath} must contain a JSON object`);
  }
  if (!Array.isArray(parsed.commands)) {
    throw new Error(`Scenario ${location.sourcePath} must contain a commands array`);
  }

  return {
    slug: location.slug,
    name: scenarioDisplayName(parsed, location.sourcePath),
    description: requireNonEmptyString(parsed, 'description', location.sourcePath),
    family: location.family,
    commandCount: parsed.commands.length,
    sourceUrl: sourceUrl(location.sourcePath, 'view'),
  };
}

export async function getScenarioGroups(): Promise<ScenarioGroup[]> {
  const scenariosRoot = resolveRepositoryPath('scenarios');
  const files = (await discoverJsonFiles(scenariosRoot)).sort((left, right) =>
    left.localeCompare(right),
  );
  const scenarios = await Promise.all(
    files.map((filePath) => parseScenario(scenariosRoot, filePath)),
  );
  const grouped = new Map<string, ScenarioCard[]>();

  for (const scenario of scenarios) {
    const familyScenarios = grouped.get(scenario.family) ?? [];
    familyScenarios.push(scenario);
    grouped.set(scenario.family, familyScenarios);
  }

  return [...grouped]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family, familyScenarios]) => ({ family, scenarios: familyScenarios }));
}
