import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { finalizeEvent } from 'nostr-tools';
import { runCdkReceiver } from '../src/cdk-process.js';

it.each(['null', '{"type":"result","result":"invented"}', 'not-json'])(
  'rejects malformed native process output without exposing diagnostics: %s',
  async (frame) => {
    const directory = await mkdtemp(join(tmpdir(), 'cdk-process-test-'));
    try {
      const binary = join(directory, 'receiver');
      await writeFile(
        binary,
        `#!/bin/sh\nread -r input\nprintf '%s\\n' '${frame}'\nprintf '%s\\n' 'private-key-do-not-log' >&2\n`,
      );
      await chmod(binary, 0o700);
      const key = Uint8Array.from([...Array(31).fill(0), 1]);
      const event = finalizeEvent({ kind: 1, created_at: 1, content: '', tags: [] }, key);
      await expect(
        runCdkReceiver(
          binary,
          {
            database: join(directory, 'unused.sqlite'),
            keyHex: Buffer.from(key).toString('hex'),
            event,
            info: event,
            relays: [],
            pauseAfterSwap: false,
          },
          'unused',
          async () => 'continue',
        ),
      ).rejects.toThrow(/^CDK receiver failed$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
