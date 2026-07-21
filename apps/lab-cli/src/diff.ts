import type { HistoryEvent, ScenarioRunResult } from '@cashu-fault-lab/scenario-runner';

export interface ScenarioDiff {
  readonly scenarioIdChanged: boolean;
  readonly seedChanged: boolean;
  readonly statusChanged: boolean;
  readonly errorChanged: boolean;
  readonly commandCountChanged: boolean;
  readonly commandChanges: readonly CommandChange[];
  readonly observationCounts: {
    readonly left: Readonly<Record<string, number>>;
    readonly right: Readonly<Record<string, number>>;
  };
  readonly historyLengthChanged: boolean;
  readonly capabilitiesChanged: boolean;
  readonly sameOutcome: boolean;
}

export interface CommandChange {
  readonly index: number;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly left?: unknown;
  readonly right?: unknown;
}

function countObservations(history: readonly HistoryEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of history) {
    if (event.phase !== 'observation') continue;
    counts[event.event] = (counts[event.event] ?? 0) + 1;
  }
  return counts;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function commandsEqual(left: unknown, right: unknown): boolean {
  return safeStringify(left) === safeStringify(right);
}

function capabilitiesEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  return safeStringify(left) === safeStringify(right);
}

export function diffScenarios(left: ScenarioRunResult, right: ScenarioRunResult): ScenarioDiff {
  const leftCommands = left.artifact.commands;
  const rightCommands = right.artifact.commands;
  const commandChanges: CommandChange[] = [];
  const max = Math.max(leftCommands.length, rightCommands.length);
  for (let index = 0; index < max; index += 1) {
    const l = leftCommands[index];
    const r = rightCommands[index];
    if (l === undefined && r !== undefined) {
      commandChanges.push({ index, kind: 'added', right: r });
    } else if (l !== undefined && r === undefined) {
      commandChanges.push({ index, kind: 'removed', left: l });
    } else if (l !== undefined && r !== undefined && !commandsEqual(l, r)) {
      commandChanges.push({ index, kind: 'changed', left: l, right: r });
    }
  }

  const statusChanged = left.status !== right.status;
  const errorChanged =
    left.status === 'failed' &&
    right.status === 'failed' &&
    (left.error.name !== right.error.name || left.error.message !== right.error.message);
  const scenarioIdChanged = left.artifact.scenario !== right.artifact.scenario;
  const seedChanged = left.artifact.seed !== right.artifact.seed;
  const commandCountChanged = leftCommands.length !== rightCommands.length;
  const historyLengthChanged = left.artifact.history.length !== right.artifact.history.length;
  const capabilitiesChanged = !capabilitiesEqual(
    left.artifact.capabilities,
    right.artifact.capabilities,
  );
  const sameOutcome =
    !statusChanged &&
    !errorChanged &&
    !commandCountChanged &&
    commandChanges.length === 0 &&
    !historyLengthChanged &&
    !capabilitiesChanged;

  return {
    scenarioIdChanged,
    seedChanged,
    statusChanged,
    errorChanged,
    commandCountChanged,
    commandChanges,
    observationCounts: {
      left: countObservations(left.artifact.history),
      right: countObservations(right.artifact.history),
    },
    historyLengthChanged,
    capabilitiesChanged,
    sameOutcome,
  };
}

export function renderDiffText(
  leftLabel: string,
  rightLabel: string,
  left: ScenarioRunResult,
  right: ScenarioRunResult,
  diff: ScenarioDiff,
): string {
  const lines: string[] = [];
  lines.push(`diff ${leftLabel} -> ${rightLabel}`);
  lines.push(`  scenario: ${left.artifact.scenario}${diff.scenarioIdChanged ? ' (changed)' : ''}`);
  lines.push(`  seed: ${left.artifact.seed}${diff.seedChanged ? ' (changed)' : ''}`);
  lines.push(`  status: ${left.status} -> ${diff.statusChanged ? `${right.status}` : '(same)'}`);
  if (diff.errorChanged) {
    lines.push(`  error: changed`);
  } else if (left.status === 'failed') {
    lines.push(`  error: ${left.error.name}: ${left.error.message} (same)`);
  }
  lines.push(
    `  commands: ${left.artifact.commands.length} -> ${right.artifact.commands.length}${diff.commandCountChanged ? ' (changed)' : ''}`,
  );
  for (const change of diff.commandChanges) {
    if (change.kind === 'added') {
      lines.push(`    + [${change.index}] ${safeStringify(change.right)}`);
    } else if (change.kind === 'removed') {
      lines.push(`    - [${change.index}] ${safeStringify(change.left)}`);
    } else {
      lines.push(
        `    ~ [${change.index}] ${safeStringify(change.left)} -> ${safeStringify(change.right)}`,
      );
    }
  }
  const obsKeys = new Set([
    ...Object.keys(diff.observationCounts.left),
    ...Object.keys(diff.observationCounts.right),
  ]);
  const obsChanges: string[] = [];
  for (const key of obsKeys) {
    const l = diff.observationCounts.left[key] ?? 0;
    const r = diff.observationCounts.right[key] ?? 0;
    if (l !== r) obsChanges.push(`${key}: ${l} -> ${r}`);
  }
  if (obsChanges.length === 0) {
    lines.push(`  observations: (same counts)`);
  } else {
    lines.push(`  observations:`);
    for (const change of obsChanges) lines.push(`    ${change}`);
  }
  lines.push(
    `  history: ${left.artifact.history.length} -> ${right.artifact.history.length}${diff.historyLengthChanged ? ' (changed)' : ''}`,
  );
  lines.push(`  capabilities: ${diff.capabilitiesChanged ? 'changed' : 'same'}`);
  lines.push(`  outcome: ${diff.sameOutcome ? 'same' : 'different'}`);
  return `${lines.join('\n')}\n`;
}
