import { DeliveryValidationError } from './errors';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeMintUrl(value: string): string {
  const schemeSeparator = value.indexOf('://');
  const authorityStart = schemeSeparator + 3;
  const pathStart = value.indexOf('/', authorityStart);
  const authority =
    schemeSeparator === -1
      ? ''
      : value.slice(authorityStart, pathStart === -1 ? value.length : pathStart);

  if (
    value !== value.trim() ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    authority.includes('@')
  ) {
    throw new DeliveryValidationError(
      'INVALID_MINT_URL',
      'Mint URL cannot contain whitespace, backslashes, credentials, query, or fragment',
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DeliveryValidationError('INVALID_MINT_URL', 'Mint URL is invalid');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DeliveryValidationError('INVALID_MINT_URL', 'Mint URL must use HTTP or HTTPS');
  }

  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new DeliveryValidationError('INSECURE_MINT_URL', 'Non-loopback mint URL must use HTTPS');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new DeliveryValidationError(
      'INVALID_MINT_URL',
      'Mint URL cannot contain credentials, query, or fragment',
    );
  }

  url.hostname = url.hostname.toLowerCase();
  const pathname =
    url.pathname === '/'
      ? ''
      : url.pathname.endsWith('/')
        ? url.pathname.slice(0, -1)
        : url.pathname;

  return `${url.protocol}//${url.host}${pathname}`;
}
