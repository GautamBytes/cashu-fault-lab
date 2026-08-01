import type { LifecycleDriver } from './runner.js';
import { LifecycleScenarioRunner } from './runner.js';
import { lifecycleSeedHash, type LifecycleFailureArtifact } from './history.js';

export interface LifecycleReplayResult {
  readonly matched: boolean;
  readonly actual?: LifecycleFailureArtifact;
}

function comparable(artifact: LifecycleFailureArtifact): string {
  return JSON.stringify({ failure: artifact.failure, observations: artifact.observations });
}

export async function replayLifecycleFailure(
  artifact: LifecycleFailureArtifact,
  driver: LifecycleDriver,
  seed?: string,
): Promise<LifecycleReplayResult> {
  if (artifact.redacted) {
    throw new Error('Lifecycle replay requires secret input supplied out of band');
  }
  if (seed === undefined) throw new Error('Lifecycle replay seed must be supplied out of band');
  if (lifecycleSeedHash(seed) !== artifact.scenario.seedHash) {
    throw new Error('Lifecycle replay seed does not match the failure artifact');
  }
  const result = await new LifecycleScenarioRunner(driver).run({
    ...artifact.scenario,
    seed,
  });
  if (result.ok) return { matched: false };
  return {
    matched: comparable(result.artifact) === comparable(artifact),
    actual: result.artifact,
  };
}

function sameFailureIdentity(
  left: LifecycleFailureArtifact,
  right: LifecycleFailureArtifact,
): boolean {
  return left.failure.code === right.failure.code && left.failure.message === right.failure.message;
}

export async function minimizeLifecycleFailure(
  artifact: LifecycleFailureArtifact,
  driverFactory: () => LifecycleDriver,
  seed?: string,
): Promise<LifecycleFailureArtifact> {
  if (artifact.redacted) {
    throw new Error('Lifecycle minimization requires secret input supplied out of band');
  }
  if (seed === undefined)
    throw new Error('Lifecycle minimization seed must be supplied out of band');
  if (lifecycleSeedHash(seed) !== artifact.scenario.seedHash) {
    throw new Error('Lifecycle minimization seed does not match the failure artifact');
  }
  let minimized = artifact;
  let index = 0;
  while (index < minimized.scenario.commands.length) {
    const commands = minimized.scenario.commands.filter(
      (_, candidateIndex) => candidateIndex !== index,
    );
    const result = await new LifecycleScenarioRunner(driverFactory()).run({
      ...minimized.scenario,
      seed,
      commands,
    });
    if (!result.ok && sameFailureIdentity(artifact, result.artifact)) {
      minimized = result.artifact;
      index = 0;
      continue;
    }
    index += 1;
  }
  return minimized;
}
