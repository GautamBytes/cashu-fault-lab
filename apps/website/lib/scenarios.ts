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
  const sourcePath = `scenarios/${relativePath}`;
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));

  if (!isRecord(parsed)) {
    throw new Error(`Scenario ${sourcePath} must contain a JSON object`);
  }
  if (!Array.isArray(parsed.commands)) {
    throw new Error(`Scenario ${sourcePath} must contain a commands array`);
  }

  const [family] = relativePath.split('/');
  if (!family) {
    throw new Error(`Scenario ${sourcePath} must belong to a top-level family`);
  }

  return {
    slug: relativePath.replace(/\.json$/, ''),
    name: requireNonEmptyString(parsed, 'name', sourcePath),
    description: requireNonEmptyString(parsed, 'description', sourcePath),
    family,
    commandCount: parsed.commands.length,
    sourceUrl: sourceUrl(sourcePath, 'view'),
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
