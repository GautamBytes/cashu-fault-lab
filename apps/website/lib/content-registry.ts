import { access } from 'node:fs/promises';
import type { DocumentDefinition } from './content-types';
import { resolveRepositoryPath } from './repository';

export const CONTENT_REGISTRY: readonly DocumentDefinition[] = [
  {
    slug: 'getting-started',
    sourcePath: 'README.md',
    title: 'Getting started',
    description: 'Install Cashu Fault Lab and run the deterministic delivery demo.',
    group: 'Start',
    order: 10,
  },
  {
    slug: 'cli',
    sourcePath: 'docs/cli-reference.md',
    title: 'CLI reference',
    description: 'Reference for lab commands, artifacts, and diagnostic workflows.',
    group: 'Operate',
    order: 20,
  },
  {
    slug: 'adapters',
    sourcePath: 'docs/adapter-guide.md',
    title: 'Adapter guide',
    description: 'Integrate wallet and receiver implementations through the adapter contract.',
    group: 'Integrate',
    order: 30,
  },
  {
    slug: 'delivery-profile',
    sourcePath: 'spec/delivery-v1.md',
    title: 'Delivery profile',
    description: 'The experimental delivery-v1 interoperability profile.',
    group: 'Understand',
    order: 40,
  },
  {
    slug: 'invariants',
    sourcePath: 'spec/invariants.md',
    title: 'Invariants',
    description: 'The safety, liveness, and evidence claims evaluated by the lab.',
    group: 'Understand',
    order: 50,
  },
  {
    slug: 'threat-model',
    sourcePath: 'spec/threat-model.md',
    title: 'Threat model',
    description: 'Assets, trust boundaries, attacker capabilities, and residual risks.',
    group: 'Understand',
    order: 60,
  },
  {
    slug: 'release-notes',
    sourcePath: 'docs/releases/v0.1.0.md',
    title: 'Release notes',
    description: 'Scope and evidence for the experimental v0.1 developer preview.',
    group: 'Release',
    order: 70,
  },
  {
    slug: 'release-checklist',
    sourcePath: 'docs/releases/v0.1.0-checklist.md',
    title: 'Release checklist',
    description: 'Internal requirements and external blockers for the v0.1 preview.',
    group: 'Release',
    order: 80,
  },
];

export async function validateContentRegistry(): Promise<string[]> {
  const errors: string[] = [];
  const routes = new Set<string>();

  for (const document of CONTENT_REGISTRY) {
    if (routes.has(document.slug)) {
      errors.push(`Duplicate documentation route: ${document.slug}`);
    }
    routes.add(document.slug);

    try {
      await access(resolveRepositoryPath(document.sourcePath));
    } catch {
      errors.push(`Missing canonical content source: ${document.sourcePath}`);
    }
  }

  return errors;
}
