import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PortalShell } from '../portal-shell';

const searchCss = readFileSync(
  resolve(process.cwd(), 'components/search/search.module.css'),
  'utf8',
);

describe('documentation search', () => {
  it('opens with the keyboard shortcut and filters canonical records', async () => {
    const user = userEvent.setup();
    render(
      <PortalShell
        records={[
          {
            id: 'retry',
            title: 'Retry convergence',
            description: 'Invariant',
            href: '/docs/invariants#retry-convergence',
            text: 'response loss exact payload',
          },
        ]}
      >
        <div>Page content</div>
      </PortalShell>,
    );

    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.getByRole('dialog', { name: 'Search documentation' })).toBeVisible();
    await user.type(screen.getByRole('searchbox'), 'response loss');
    expect(screen.getByRole('link', { name: /Retry convergence/ })).toHaveAttribute(
      'href',
      '/docs/invariants#retry-convergence',
    );
  });

  it('explains how to recover from an empty search', async () => {
    const user = userEvent.setup();
    render(
      <PortalShell records={[]}>
        <div>Page content</div>
      </PortalShell>,
    );
    await user.click(screen.getByRole('button', { name: 'Search documentation' }));
    await user.type(screen.getByRole('searchbox'), 'unknown');
    expect(screen.getByText('No matching documentation.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Browse scenarios' })).toHaveAttribute(
      'href',
      '/scenarios',
    );
  });

  it('gives the empty-search recovery link an inline 44 by 44 pixel target', () => {
    const recoveryRule = searchCss.match(/\.emptyState a\s*\{([^}]*)}/)?.[1];

    expect(recoveryRule).toContain('display: inline-flex');
    expect(recoveryRule).toMatch(/min-height:\s*44px/);
    expect(recoveryRule).toMatch(/min-width:\s*44px/);
    expect(recoveryRule).toMatch(/padding:\s*0\.[5-9]\d*rem\s+0\.[5-9]\d*rem/);
  });

  it('closes on Escape and restores focus to the search trigger', async () => {
    const user = userEvent.setup();
    render(
      <PortalShell records={[]}>
        <div>Page content</div>
      </PortalShell>,
    );
    const trigger = screen.getByRole('button', { name: 'Search documentation' });

    await user.click(trigger);
    expect(screen.getByRole('searchbox')).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Search documentation' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('contains forward and reverse Tab navigation inside the modal', async () => {
    const user = userEvent.setup();
    render(
      <PortalShell
        records={[
          {
            id: 'retry',
            title: 'Retry convergence',
            description: 'Invariant',
            href: '/docs/invariants#retry-convergence',
            text: 'response loss exact payload',
          },
        ]}
      >
        <div>Page content</div>
      </PortalShell>,
    );

    await user.click(screen.getByRole('button', { name: 'Search documentation' }));
    const dialog = screen.getByRole('dialog', { name: 'Search documentation' });
    const closeButton = within(dialog).getByRole('button', { name: 'Close search' });
    const lastResult = within(dialog).getByRole('link', { name: /Retry convergence/ });

    expect(within(dialog).getByRole('searchbox')).toHaveFocus();

    lastResult.focus();
    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.tab({ shift: true });
    expect(lastResult).toHaveFocus();
  });

  it('does not intercept the shortcut inside editable fields', async () => {
    const user = userEvent.setup();
    render(
      <PortalShell records={[]}>
        <input aria-label="Scenario name" />
      </PortalShell>,
    );

    await user.click(screen.getByRole('textbox', { name: 'Scenario name' }));
    await user.keyboard('{Control>}k{/Control}');

    expect(screen.queryByRole('dialog', { name: 'Search documentation' })).not.toBeInTheDocument();
  });

  it('ranks title matches before body matches and limits results to eight', async () => {
    const user = userEvent.setup();
    const records = [
      {
        id: 'body',
        title: 'Body result',
        description: 'Invariant',
        href: '/docs/body',
        text: 'needle',
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `title-${index}`,
        title: `Needle title ${index}`,
        description: 'Reference',
        href: `/docs/title-${index}`,
        text: '',
      })),
    ];
    render(
      <PortalShell records={records}>
        <div>Page content</div>
      </PortalShell>,
    );

    await user.click(screen.getByRole('button', { name: 'Search documentation' }));
    await user.type(screen.getByRole('searchbox'), 'needle');
    const resultLinks = within(
      screen.getByRole('dialog', { name: 'Search documentation' }),
    ).getAllByRole('link');

    expect(resultLinks).toHaveLength(8);
    expect(resultLinks[0]).toHaveAccessibleName(/Needle title 0/);
  });
});
