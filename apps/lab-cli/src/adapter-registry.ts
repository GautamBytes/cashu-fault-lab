import {
  HttpAdapterClient,
  type AdapterClient,
  type AdapterTestControlClient,
  type HttpAdapterClientOptions,
} from '@cashu-fault-lab/adapter-contract';
import type { MatrixParticipant } from '@cashu-fault-lab/scenario-runner';
import {
  resolveAdapterManifest,
  type AdapterManifest,
  type ResolvedAdapterRegistration,
} from './adapter-manifest.js';

export interface ExternalAdapterRegistryDependencies {
  readonly fetch?: typeof fetch;
}

export interface ExternalEvidenceAuthorities {
  readonly ledger?: Pick<AdapterClient, 'ledger'>;
  readonly mint?: Pick<AdapterClient, 'proofs'>;
}

export class ExternalAdapterRegistry {
  readonly #orderedIds: readonly string[];
  readonly #clients: ReadonlyMap<string, AdapterClient & AdapterTestControlClient>;
  readonly #evidence: ReadonlyMap<string, ExternalEvidenceAuthorities>;
  readonly #participants: readonly MatrixParticipant[];

  private constructor(
    registrations: readonly ResolvedAdapterRegistration[],
    clients: ReadonlyMap<string, AdapterClient & AdapterTestControlClient>,
    evidence: ReadonlyMap<string, ExternalEvidenceAuthorities>,
    participants: readonly MatrixParticipant[],
  ) {
    this.#orderedIds = registrations.map((registration) => registration.id);
    this.#clients = clients;
    this.#evidence = evidence;
    this.#participants = participants;
  }

  static async load(
    manifest: AdapterManifest,
    env: Readonly<Record<string, string | undefined>>,
    dependencies: ExternalAdapterRegistryDependencies = {},
  ): Promise<ExternalAdapterRegistry> {
    const registrations = resolveAdapterManifest(manifest, env);
    const clients = new Map<string, AdapterClient & AdapterTestControlClient>();
    const evidence = new Map<string, ExternalEvidenceAuthorities>();
    const participants: MatrixParticipant[] = [];
    for (const registration of registrations) {
      const options: HttpAdapterClientOptions = {
        baseUrl: registration.url,
        token: registration.token,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      };
      const client = new HttpAdapterClient(options);
      const capabilities = await client.capabilities();
      if (capabilities.implementation.id !== registration.id) {
        throw new Error(
          `Adapter identity mismatch: expected ${registration.id}, received ${capabilities.implementation.id}`,
        );
      }
      clients.set(registration.id, client);
      if (registration.evidence !== undefined) {
        evidence.set(registration.id, {
          ...(registration.evidence.ledger === undefined
            ? {}
            : {
                ledger: new HttpAdapterClient({
                  baseUrl: registration.evidence.ledger.url,
                  token: registration.evidence.ledger.token,
                  ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
                }),
              }),
          ...(registration.evidence.mint === undefined
            ? {}
            : {
                mint: new HttpAdapterClient({
                  baseUrl: registration.evidence.mint.url,
                  token: registration.evidence.mint.token,
                  ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
                }),
              }),
        });
      }
      participants.push({ id: registration.id, capabilities });
    }
    return new ExternalAdapterRegistry(registrations, clients, evidence, participants);
  }

  ids(): readonly string[] {
    return [...this.#orderedIds];
  }

  client(id: string): (AdapterClient & AdapterTestControlClient) | undefined {
    return this.#clients.get(id);
  }

  evidence(id: string): ExternalEvidenceAuthorities | undefined {
    return this.#evidence.get(id);
  }

  participants(): readonly MatrixParticipant[] {
    return [...this.#participants];
  }
}
