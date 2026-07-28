import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SiteHeader } from '../components/site-header';

describe('SiteHeader', () => {
  it('exposes the primary developer navigation', () => {
    render(<SiteHeader />);
    const brand = screen.getByRole('link', { name: 'Cashu Fault Lab' });
    expect(brand).toHaveAttribute('href', '/');
    expect(brand.querySelector('img')).toHaveAttribute('src', '/cashu-fault-lab.png');
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      '/docs/getting-started',
    );
    expect(screen.getByRole('link', { name: 'CLI' })).toHaveAttribute('href', '/docs/cli');
    expect(screen.getByRole('link', { name: 'Adapters' })).toHaveAttribute(
      'href',
      '/docs/adapters',
    );
    expect(screen.getByRole('link', { name: 'Scenarios' })).toHaveAttribute('href', '/scenarios');
    expect(screen.getByRole('link', { name: 'Release status' })).toHaveAttribute(
      'href',
      '/release-status',
    );
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/GautamBytes/cashu-fault-lab',
    );
  });
});
