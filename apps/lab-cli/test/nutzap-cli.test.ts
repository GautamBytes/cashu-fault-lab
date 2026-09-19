import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/index.js';
describe('nutzap commands', () => {
  it('lists shared-journal and independent-wallet recovery scenarios', async () => {
    let out = '';
    const io: CliIo = {
      stdout: (s) => {
        out += s;
      },
      stderr: () => {},
      readText: async () => '',
      realPath: async (p) => p,
      writeText: async () => {},
    };
    expect((await runCli(['node', 'lab', 'nutzap', 'list'], { io })).exitCode).toBe(0);
    expect(JSON.parse(out)).toHaveLength(26);
    expect(JSON.parse(out)).toContain('cdk-key-rotation-delayed');
    expect(JSON.parse(out)).toContain('cdk-key-rotation-crash-after-swap');
    expect(JSON.parse(out)).toContain('cdk-key-rotation-missing-key');
    expect(JSON.parse(out)).toContain('key-rotation-delayed');
    expect(JSON.parse(out)).toContain('key-rotation-crash-after-swap');
    expect(JSON.parse(out)).toContain('key-rotation-missing-key');
    expect(JSON.parse(out)).toContain('independent-crash-after-swap');
    expect(JSON.parse(out)).toContain('cdk-peer-crash-after-swap');
    expect(JSON.parse(out)).toContain('post-spend-stale-relay');
    expect(JSON.parse(out)).toContain('post-spend-publication-crash');
    expect(JSON.parse(out)).toContain('cdk-post-spend-publication-crash');
    expect(JSON.parse(out)).toContain('cdk-peer-post-spend-stale-relay');
  });
  it('rejects an unknown case before running or writing a report', async () => {
    let writes = 0;
    const io: CliIo = {
      stdout: () => {},
      stderr: () => {},
      readText: async () => '',
      realPath: async (p) => p,
      writeText: async () => {
        writes++;
      },
    };
    expect((await runCli(['node', 'lab', 'nutzap', 'run', 'unknown'], { io })).exitCode).toBe(2);
    expect(writes).toBe(0);
  });
});
