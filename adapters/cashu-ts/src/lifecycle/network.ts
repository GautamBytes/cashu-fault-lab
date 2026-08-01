import {
  HttpResponseError,
  JSONInt,
  MintOperationError,
  NetworkError,
  type RequestFn,
} from '@cashu/cashu-ts';
import { AsyncLocalStorage } from 'node:async_hooks';

export const CASHU_TS_LIFECYCLE_MAX_MINT_RESPONSE_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const operationContext = new AsyncLocalStorage<string>();

export function withCashuTsLifecycleOperation<T>(
  operationId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error('Cashu lifecycle operation ID is invalid');
  }
  return operationContext.run(operationId, work);
}

export interface CashuTsLifecycleRequestPolicy {
  readonly defaultTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function isLoopbackMint(mintUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(mintUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

export function validatedMintOrigin(mintUrl: string, allowUnsafeMint: boolean): URL {
  let url: URL;
  try {
    url = new URL(mintUrl);
  } catch {
    throw new Error('Cashu lifecycle mint URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Cashu lifecycle mint URL protocol is invalid');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('Cashu lifecycle mint URL contains forbidden components');
  }
  if (!isLoopbackMint(mintUrl) && (!allowUnsafeMint || url.protocol !== 'https:')) {
    throw new Error('Cashu lifecycle external mint requires explicit HTTPS unsafe opt-in');
  }
  return url;
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    throw new HttpResponseError(
      'Cashu lifecycle mint response exceeds byte limit',
      response.status,
    );
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpResponseError(
          'Cashu lifecycle mint response exceeds byte limit',
          response.status,
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function createCashuTsNoRedirectRequest(
  mintUrl: string,
  policy: CashuTsLifecycleRequestPolicy = {},
): RequestFn {
  const allowedOrigin = new URL(mintUrl).origin;
  const defaultTimeoutMs = positiveInteger(
    policy.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'defaultTimeoutMs',
  );
  const maxResponseBytes = positiveInteger(
    policy.maxResponseBytes ?? CASHU_TS_LIFECYCLE_MAX_MINT_RESPONSE_BYTES,
    'maxResponseBytes',
  );
  return async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
    let endpoint: URL;
    try {
      endpoint = new URL(args.endpoint);
    } catch (cause) {
      throw new NetworkError('Cashu lifecycle mint request URL is invalid', { cause });
    }
    if (endpoint.origin !== allowedOrigin) {
      throw new NetworkError('Cashu lifecycle mint request changed origin');
    }
    const requestBody =
      args.requestBody === undefined ? undefined : JSONInt.stringify(args.requestBody);
    if (args.requestBody !== undefined && requestBody === undefined) {
      throw new NetworkError('Cashu lifecycle mint request body is invalid');
    }
    const timeoutMs = positiveInteger(args.requestTimeout ?? defaultTimeoutMs, 'requestTimeout');
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal =
      args.signal == null
        ? timeoutController.signal
        : AbortSignal.any([args.signal, timeoutController.signal]);
    try {
      let response: Response;
      try {
        const operationId = isLoopbackMint(mintUrl) ? operationContext.getStore() : undefined;
        response = await fetch(endpoint, {
          method: args.method ?? (args.requestBody === undefined ? 'GET' : 'POST'),
          headers: {
            ...(args.requestBody === undefined ? {} : { 'content-type': 'application/json' }),
            ...args.headers,
            ...(operationId === undefined ? {} : { 'x-cashu-fault-operation-id': operationId }),
          },
          ...(requestBody === undefined ? {} : { body: requestBody }),
          signal,
          cache: 'no-store',
          credentials: 'omit',
          referrer: '',
          referrerPolicy: 'no-referrer',
          redirect: 'manual',
        });
      } catch (cause) {
        if (cause instanceof NetworkError) throw cause;
        throw new NetworkError('Cashu lifecycle mint request failed', { cause });
      }
      try {
        args.onResponseMeta?.({
          endpoint: args.endpoint,
          status: response.status,
          headers: response.headers,
        });
      } catch {
        // Response metadata is diagnostic and must not change protocol request semantics.
      }
      if (response.status >= 300 && response.status < 400) {
        throw new HttpResponseError('Cashu lifecycle mint redirect is forbidden', response.status);
      }
      const text = await boundedResponseText(response, maxResponseBytes);
      let value: unknown;
      try {
        value = text.length === 0 ? undefined : JSONInt.parse(text);
      } catch (cause) {
        throw new HttpResponseError(
          'Cashu lifecycle mint response is not valid JSON',
          response.status,
          { cause },
        );
      }
      if (!response.ok) {
        if (
          typeof value === 'object' &&
          value !== null &&
          Number.isSafeInteger(Reflect.get(value, 'code')) &&
          typeof Reflect.get(value, 'detail') === 'string'
        ) {
          throw new MintOperationError(
            Reflect.get(value, 'code') as number,
            Reflect.get(value, 'detail') as string,
          );
        }
        throw new HttpResponseError('Cashu lifecycle mint HTTP request failed', response.status);
      }
      return value as T;
    } finally {
      clearTimeout(timeout);
    }
  };
}
