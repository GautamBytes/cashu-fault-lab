const LOCAL_SITE_URL = 'http://localhost:3000';

function vercelHostUrl(value: string | undefined): URL | undefined {
  const host = value?.trim().replace(/^https?:\/\//i, '');
  if (!host) return undefined;

  try {
    const url = new URL(`https://${host}`);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

export function resolveSiteUrl(
  environment: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): URL {
  return (
    vercelHostUrl(environment.VERCEL_PROJECT_PRODUCTION_URL) ??
    vercelHostUrl(environment.VERCEL_URL) ??
    new URL(LOCAL_SITE_URL)
  );
}

export function serializeJsonLd(value: object): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

export const siteUrl = resolveSiteUrl();
