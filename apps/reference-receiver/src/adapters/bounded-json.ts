import { TextDecoder } from 'node:util';

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error(`${label} is too large`);
    }
  }
  if (!response.body) throw new Error(`${label} is empty`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} is too large`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} is invalid UTF-8 JSON`);
  }
}
