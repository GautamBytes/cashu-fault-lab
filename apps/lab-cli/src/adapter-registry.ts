import {
  HttpAdapterClient,
  type AdapterClient,
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

export class ExternalAdapterRegistry {
  readonly #orderedIds: readonly string[];
  readonly #clients: ReadonlyMap<string, AdapterClient>;
  readonly #participants: readonly MatrixParticipant[];

  private constructor(
    registrations: readonly ResolvedAdapterRegistration[],
    clients: ReadonlyMap<string, AdapterClient>,
    participants: readonly MatrixParticipant[],
  ) {
    this.#orderedIds = registrations.map((registration) => registration.id);
    this.#clients = clients;
    this.#participants = participants;
  }

  static async load(
    manifest: AdapterManifest,
    env: Readonly<Record<string, string | undefined>>,
    dependencies: ExternalAdapterRegistryDependencies = {},
  ): Promise<ExternalAdapterRegistry> {
    const registrations = resolveAdapterManifest(manifest, env);
    const clients = new Map<string, AdapterClient>();
    const participants: MatrixParticipant[] = [];
    for (const registration of registrations) {
      const options: HttpAdapterClientOptions = {
        baseUrl: registration.url,
        token: registration.token,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      };
      const client = new HttpAdapterClient(options);
      const capabilities = await client.capabilities();
      if (capabilities.implementation !== registration.id) {
        throw new Error(
          `Adapter identity mismatch: expected ${registration.id}, received ${capabilities.implementation}`,
        );
      }
      clients.set(registration.id, client);
      participants.push({ id: registration.id, capabilities });
    }
    return new ExternalAdapterRegistry(registrations, clients, participants);
  }

  ids(): readonly string[] {
    return [...this.#orderedIds];
  }

  client(id: string): AdapterClient | undefined {
    return this.#clients.get(id);
  }

  participants(): readonly MatrixParticipant[] {
    return [...this.#participants];
  }
}
