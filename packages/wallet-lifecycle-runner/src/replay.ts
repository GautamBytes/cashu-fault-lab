import type { LifecycleDriver } from './runner.js';
import { LifecycleScenarioRunner } from './runner.js';
import type { LifecycleFailureArtifact } from './history.js';

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
): Promise<LifecycleReplayResult> {
  if (artifact.redacted) {
    throw new Error('Lifecycle replay requires secret input supplied out of band');
  }
  const result = await new LifecycleScenarioRunner(driver).run(artifact.scenario);
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
): Promise<LifecycleFailureArtifact> {
  if (artifact.redacted) {
    throw new Error('Lifecycle minimization requires secret input supplied out of band');
  }
  let minimized = artifact;
  let index = 0;
  while (index < minimized.scenario.commands.length) {
    const commands = minimized.scenario.commands.filter(
      (_, candidateIndex) => candidateIndex !== index,
    );
    const result = await new LifecycleScenarioRunner(driverFactory()).run({
      ...minimized.scenario,
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
