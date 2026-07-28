import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';
import { CodeBlock } from './code-block';
import { resolveMarkdownHref, SafeMarkdownLink } from './markdown-document';

describe('repository Markdown links', () => {
  it('maps a canonical document linked from the repository root to its docs route', () => {
    expect(resolveMarkdownHref('docs/releases/v0.1.0.md', 'README.md')).toBe('/docs/release-notes');
  });

  it('resolves canonical documents relative to a nested source file', () => {
    expect(resolveMarkdownHref('v0.1.0-checklist.md', 'docs/releases/v0.1.0.md')).toBe(
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
      resolveMarkdownHref('v0.1.0-checklist.md#external-blockers', 'docs/releases/v0.1.0.md'),
    ).toBe('/docs/release-checklist#external-blockers');
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
      <CodeBlock {...props}>
        <code>pnpm test</code>
      </CodeBlock>,
    );

    expect(screen.getByText('pnpm test').closest('pre')).not.toHaveAttribute('node');
  });
});
