import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Cashu Fault Lab',
    short_name: 'Fault Lab',
    description:
      'An experimental developer preview for Cashu delivery fault injection and recovery evidence.',
    start_url: '/',
    display: 'standalone',
    background_color: '#09070d',
    theme_color: '#2b0c4a',
    icons: [
      {
        src: '/icon.png',
        sizes: '200x200',
        type: 'image/png',
      },
    ],
  };
}
