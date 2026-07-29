import type { MetadataRoute } from 'next';
import { getDocumentationDestinations } from '../lib/content-registry';
import { siteUrl } from './site-metadata';

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    '',
    '/scenarios',
    '/release-status',
    ...getDocumentationDestinations().map(({ href }) => href),
  ];

  return routes.map((route) => ({
    url: new URL(route || '/', siteUrl).toString(),
    changeFrequency: route === '' ? 'weekly' : 'monthly',
    priority: route === '' ? 1 : route.startsWith('/docs/') ? 0.7 : 0.8,
  }));
}
