import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';
import { CodeBlock } from './code-block';
import {
  prepareMarkdownForDocumentPage,
  resolveMarkdownHref,
  SafeMarkdownLink,
} from './markdown-document';

const docsCss = readFileSync(resolve(process.cwd(), 'components/docs/docs.module.css'), 'utf8');

describe('repository Markdown links', () => {
  it('maps a canonical document linked from the repository root to its docs route', () => {
    expect(resolveMarkdownHref('docs/releases/v0.2.0.md', 'README.md')).toBe('/docs/release-notes');
  });

  it('resolves canonical documents relative to a nested source file', () => {
    expect(resolveMarkdownHref('v0.2.0-checklist.md', 'docs/releases/v0.2.0.md')).toBe(
      '/docs/release-checklist',
    );
  });

  it('falls back to the GitHub blob URL for other repository files', () => {
    expect(resolveMarkdownHref('../examples/v0.1.0-demo.json', 'docs/releases/v0.1.0.md')).toBe(
      'https://github.com/GautamBytes/cashu-fault-lab/blob/main/docs/examples/v0.1.0-demo.json',
    );
  });

  it('preserves anchors when resolving repository files', () => {
    expect(
      resolveMarkdownHref('./schemas/delivery-request.schema.json#request', 'spec/delivery-v1.md'),
    ).toBe(
      'https://github.com/GautamBytes/cashu-fault-lab/blob/main/spec/schemas/delivery-request.schema.json#request',
    );
    expect(
      resolveMarkdownHref(
        'v0.2.0-checklist.md#external-validation-blockers',
        'docs/releases/v0.2.0.md',
      ),
    ).toBe('/docs/release-checklist#external-validation-blockers');
  });

  it('leaves anchors, in-site routes, and external URLs unchanged', () => {
    expect(resolveMarkdownHref('#safety', 'spec/invariants.md')).toBe('#safety');
    expect(resolveMarkdownHref('/scenarios', 'README.md')).toBe('/scenarios');
    expect(resolveMarkdownHref('https://example.com/docs', 'README.md')).toBe(
      'https://example.com/docs',
    );
  });
});

describe('Markdown component props', () => {
  it('renders inline code as plain monospace prose without decorative boxes', () => {
    expect(docsCss).toMatch(
      /\.markdown :not\(pre\) > code\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*font-size:\s*0\.94em;[^}]*padding:\s*0;/s,
    );
  });

  it('removes only the canonical leading title before rendering inside the page shell', () => {
    const markdown =
      '# Canonical title\n\nIntroduction.\n\n## Details\n\nBody.\n\n# Deliberate later heading\n';

    expect(prepareMarkdownForDocumentPage(markdown)).toBe(
      '\nIntroduction.\n\n## Details\n\nBody.\n\n# Deliberate later heading\n',
    );
  });

  it("does not emit React Markdown's internal node prop on links", () => {
    const props = {
      href: '../examples/v0.1.0-demo.json',
      node: { type: 'element' },
      sourcePath: 'docs/releases/v0.1.0.md',
    } as ComponentProps<typeof SafeMarkdownLink> & { node: unknown };

    render(<SafeMarkdownLink {...props}>Evidence</SafeMarkdownLink>);

    const link = screen.getByRole('link', { name: 'Evidence' });
    expect(link).not.toHaveAttribute('node');
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/GautamBytes/cashu-fault-lab/blob/main/docs/examples/v0.1.0-demo.json',
    );
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it("does not emit React Markdown's internal node prop on code blocks", () => {
    const props = {
      node: { type: 'element' },
    } as ComponentProps<typeof CodeBlock> & { node: unknown };

    render(
      <CodeBlock {...props} data-language="bash">
        <code>pnpm test</code>
      </CodeBlock>,
    );

    expect(screen.getByText('pnpm test').closest('pre')).not.toHaveAttribute('node');
    expect(screen.getByText('bash')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeVisible();
  });
});
