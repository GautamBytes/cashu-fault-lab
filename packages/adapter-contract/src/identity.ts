import { createHash } from 'node:crypto';
import type { AdapterImplementationIdentity } from './types.js';

export interface DevelopmentIdentityInput {
  readonly id: string;
  readonly version: string;
  readonly language: string;
  readonly runtime: string;
}

function digest(domain: 'source' | 'build', input: DevelopmentIdentityInput): string {
  const identity = [input.id, input.version, input.language, input.runtime].join('\0');
  return `sha256:${createHash('sha256').update(`cashu-fault-lab/${domain}/v1\0${identity}`).digest('hex')}`;
}

export function developmentIdentity(
  input: DevelopmentIdentityInput,
): AdapterImplementationIdentity {
  return {
    ...input,
    sourceDigest: digest('source', input),
    buildDigest: digest('build', input),
  };
}

export function isDevelopmentIdentity(identity: AdapterImplementationIdentity): boolean {
  const expected = developmentIdentity(identity);
  return (
    identity.sourceDigest === expected.sourceDigest && identity.buildDigest === expected.buildDigest
  );
}
