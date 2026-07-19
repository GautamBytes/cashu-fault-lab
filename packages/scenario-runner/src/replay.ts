import type { FailureArtifact, ScenarioCommand } from './runner.js';

export function assertReplayableArtifact(value: FailureArtifact): void {
  if (value.schemaVersion !== 1) throw new Error('Unsupported artifact schema version');
  if (
    typeof value.seed !== 'string' ||
    value.seed.length === 0 ||
    typeof value.scenario !== 'string' ||
    value.scenario.length === 0 ||
    !Array.isArray(value.commands)
  ) {
    throw new Error('Invalid replay artifact');
  }
}

export async function minimizeFailingCommands(
  commands: readonly ScenarioCommand[],
  stillFails: (candidate: readonly ScenarioCommand[]) => Promise<boolean>,
  runLimit = 100,
): Promise<readonly ScenarioCommand[]> {
  if (!Number.isSafeInteger(runLimit) || runLimit < 1) throw new Error('Invalid shrink run limit');
  let candidate = [...commands];
  let chunkSize = Math.max(1, Math.floor(candidate.length / 2));
  let runs = 0;

  while (candidate.length > 1 && runs < runLimit) {
    let reduced = false;
    for (let start = 0; start < candidate.length && runs < runLimit; start += chunkSize) {
      const next = [...candidate.slice(0, start), ...candidate.slice(start + chunkSize)];
      if (next.length === 0) continue;
      runs += 1;
      if (await stillFails(next)) {
        candidate = next;
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (chunkSize === 1) break;
      chunkSize = Math.max(1, Math.floor(chunkSize / 2));
    } else {
      chunkSize = Math.min(chunkSize, Math.max(1, Math.floor(candidate.length / 2)));
    }
  }
  return candidate;
}
