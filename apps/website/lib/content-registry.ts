import { access } from 'node:fs/promises';
import type {
  DocumentationDestination,
  DocumentationLink,
  GeneratedDocumentPage,
  MarkdownDocumentDefinition,
} from './content-types';
import { resolveRepositoryPath } from './repository';

export const DOCUMENTATION_DESTINATIONS: readonly DocumentationDestination[] = [
  {
    kind: 'markdown',
    slug: 'getting-started',
    href: '/docs/getting-started',
    sourcePath: 'docs/getting-started.md',
    title: 'Getting started',
    description: 'Install Cashu Fault Lab and run the deterministic delivery demo.',
    group: 'Start',
    order: 10,
  },
  {
    kind: 'markdown',
    slug: 'contributing',
    href: '/docs/contributing',
    sourcePath: 'CONTRIBUTING.md',
    title: 'Contribution guide',
    description: 'Set up the repository locally and contribute changes through a pull request.',
    group: 'Start',
    order: 15,
  },
  {
    kind: 'markdown',
    slug: 'cli',
    href: '/docs/cli',
    sourcePath: 'docs/cli-reference.md',
    title: 'CLI reference',
    description: 'Reference for lab commands, artifacts, and diagnostic workflows.',
    group: 'Operate',
    order: 20,
  },
  {
    kind: 'markdown',
    slug: 'adapters',
    href: '/docs/adapters',
    sourcePath: 'docs/adapter-guide.md',
    title: 'Adapter guide',
    description: 'Integrate wallet and receiver implementations through the adapter contract.',
    group: 'Integrate',
    order: 30,
  },
  {
    kind: 'markdown',
    slug: 'wallet-lifecycle',
    href: '/docs/wallet-lifecycle',
    sourcePath: 'docs/wallet-lifecycle.md',
    title: 'Wallet lifecycle',
    description: 'Crash-safe wallet operations, recovery semantics, and the current preview scope.',
    group: 'Integrate',
    order: 35,
  },
  {
    kind: 'markdown',
    slug: 'wallet-doctor',
    href: '/docs/wallet-doctor',
    sourcePath: 'docs/wallet-doctor.md',
    title: 'NIP-60 wallet doctor',
    description: 'Multi-relay wallet-state diagnosis, mint verification, and dry-run repair plans.',
    group: 'Integrate',
    order: 36,
  },
  {
    kind: 'generated',
    slug: 'architecture',
    href: '/architecture',
    title: 'Architecture',
    description:
      'How Cashu Fault Lab separates delivery faults from independent recovery evidence.',
    group: 'Integrate',
    order: 40,
    headings: [
      {
        depth: 2,
        id: 'flow-title',
        text: 'One delivery. Separate authorities.',
        searchText:
          'Durable sender, HTTP and Nostr faults, and durable receiver evidence branch through exact payload and mint recovery before converging at the independent oracle and JSON, JUnit, and HTML evidence.',
      },
      {
        depth: 2,
        id: 'separation-title',
        text: 'Recovery behavior is not release evidence.',
        searchText:
          'A sender may converge and a receiver may avoid duplicate credit while the release gate remains blocked. Qualification additionally requires independent implementations, mints, authorities, and review.',
      },
    ],
    searchText:
      'Durable sender, HTTP and Nostr faults, and durable receiver evidence converge at an independent oracle before JSON, JUnit, and HTML evidence is emitted.',
  },
  {
    kind: 'markdown',
    slug: 'delivery-profile',
    href: '/docs/delivery-profile',
    sourcePath: 'spec/delivery-v1.md',
    title: 'Delivery profile',
    description: 'The experimental delivery-v1 interoperability profile.',
    group: 'Understand',
    order: 50,
  },
  {
    kind: 'markdown',
    slug: 'invariants',
    href: '/docs/invariants',
    sourcePath: 'spec/invariants.md',
    title: 'Invariants',
    description: 'The safety, liveness, and evidence claims evaluated by the lab.',
    group: 'Understand',
    order: 60,
  },
  {
    kind: 'markdown',
    slug: 'threat-model',
    href: '/docs/threat-model',
    sourcePath: 'spec/threat-model.md',
    title: 'Threat model',
    description: 'Assets, trust boundaries, attacker capabilities, and residual risks.',
    group: 'Understand',
    order: 70,
  },
  {
    kind: 'markdown',
    slug: 'release-notes',
    href: '/docs/release-notes',
    sourcePath: 'docs/releases/v0.2.0.md',
    title: 'Release notes',
    description: 'What changed in the v0.2 developer preview and how to try it.',
    group: 'Release',
    order: 80,
  },
  {
    kind: 'markdown',
    slug: 'release-checklist',
    href: '/docs/release-checklist',
    sourcePath: 'docs/releases/v0.2.0-checklist.md',
    title: 'Release checklist',
    description: 'Completed v0.2.0 requirements and remaining external-validation blockers.',
    group: 'Release',
    order: 90,
  },
];

export function isMarkdownDestination(
  destination: DocumentationDestination,
): destination is MarkdownDocumentDefinition {
  return destination.kind === 'markdown';
}

export const CONTENT_REGISTRY: readonly MarkdownDocumentDefinition[] =
  DOCUMENTATION_DESTINATIONS.filter(isMarkdownDestination);

export function getDocumentationDestinations(): DocumentationDestination[] {
  return [...DOCUMENTATION_DESTINATIONS].sort((left, right) => left.order - right.order);
}

function navigationLink(
  destination: DocumentationDestination | undefined,
): DocumentationLink | undefined {
  if (!destination) return undefined;
  return {
    href: destination.href,
    slug: destination.slug,
    title: destination.title,
  };
}

export function getDocumentationNeighbors(slug: string): {
  previous?: DocumentationLink;
  next?: DocumentationLink;
} {
  const destinations = getDocumentationDestinations();
  const index = destinations.findIndex((destination) => destination.slug === slug);
  if (index < 0) return {};

  const previous = navigationLink(destinations[index - 1]);
  const next = navigationLink(destinations[index + 1]);
  return {
    ...(previous ? { previous } : {}),
    ...(next ? { next } : {}),
  };
}

export function getGeneratedDocumentPage(slug: string): GeneratedDocumentPage | undefined {
  const destination = DOCUMENTATION_DESTINATIONS.find((item) => item.slug === slug);
  if (!destination || destination.kind !== 'generated') return undefined;
  return { ...destination, ...getDocumentationNeighbors(slug) };
}

export async function validateContentRegistry(): Promise<string[]> {
  const errors: string[] = [];
  const routes = new Set<string>();

  for (const document of DOCUMENTATION_DESTINATIONS) {
    if (routes.has(document.slug)) {
      errors.push(`Duplicate documentation route: ${document.slug}`);
    }
    routes.add(document.slug);

    if (!isMarkdownDestination(document)) continue;

    try {
      await access(resolveRepositoryPath(document.sourcePath));
    } catch {
      errors.push(`Missing canonical content source: ${document.sourcePath}`);
    }
  }

  return errors;
}
