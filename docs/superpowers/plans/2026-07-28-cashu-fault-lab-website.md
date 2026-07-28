# Cashu Fault Lab Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a searchable, multi-page Cashu Fault Lab developer portal whose documentation, scenarios, release data, and demo evidence are generated from canonical repository files.

**Architecture:** Add a Next.js App Router application at `apps/website`. Server-only build readers load repository Markdown and JSON into typed page models; static routes render those models, while small client components provide search, copy, navigation, and motion. Vercel builds from the repository root so the website never needs a duplicate content directory.

**Tech Stack:** Node.js 24, pnpm 11.15.0, Next.js 16.2.12, React 19.2.8, TypeScript 7, React Markdown 10.1.0, Shiki 4.3.1, Vitest 4.1.10, Playwright 1.62.0, CSS Modules, Vercel.

## Global Constraints

- Repository Markdown and JSON remain the only source for documentation, scenarios, release policy, and demo evidence.
- Cashu purple `#7F38CA` and Cashu sand `#DCC099` are the only hue families.
- Accessible tonal endpoints are purple `#2B0C4A` and sand `#F6EBD6`; no red, green, orange, blue, black, or white status colors.
- The site must always say “experimental developer preview,” never “certified” or “production-safe.”
- Only `docs/examples/v0.1.0-demo.json` may feed the public evidence visualization.
- Runtime environment variables and ignored `artifacts/` files must never enter the browser bundle.
- All content pages are statically generated during `next build`.
- Desktop, 768px tablet, and 390px mobile layouts must have no page-level horizontal overflow.
- Animation must stop under `prefers-reduced-motion: reduce`.
- Every code implementation step follows red-green-refactor and ends with the listed focused tests.
- Execute with `PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm`.

---

## File map

### Workspace and deployment

- `package.json`: root shortcuts for website development, tests, and builds.
- `turbo.json`: cache the website's `.next` output without changing existing package outputs.
- `pnpm-lock.yaml`: pin the new application dependencies.
- `.gitignore`: ignore Next, Playwright, and Vercel local output.
- `.vercelignore`: exclude runtime artifacts, local stores, worktrees, and test output from uploads.
- `vercel.json`: build the website workspace from the repository root.

### Application shell

- `apps/website/package.json`: application dependencies and scripts.
- `apps/website/next.config.mjs`: Next.js project configuration.
- `apps/website/tsconfig.json`: strict Next.js TypeScript settings.
- `apps/website/next-env.d.ts`: Next.js type declarations.
- `apps/website/vitest.config.ts`: jsdom unit-test configuration.
- `apps/website/playwright.config.ts`: local browser-test server and projects.
- `apps/website/test/setup.ts`: DOM matcher setup.
- `apps/website/app/layout.tsx`: fonts, metadata, search data, and global shell.
- `apps/website/app/globals.css`: reset, brand tokens, global typography, accessibility helpers.
- `apps/website/components/portal-shell.tsx`: client-owned search and mobile-navigation state around server-rendered pages.
- `apps/website/components/site-header.tsx`: desktop header, mobile controls, search trigger.
- `apps/website/components/site-header.module.css`: responsive navigation styling.

### Canonical content

- `apps/website/lib/content-registry.ts`: route/source metadata only.
- `apps/website/lib/repository.ts`: repository-root resolution and traversal protection.
- `apps/website/lib/markdown.ts`: heading extraction, search normalization, and document loading.
- `apps/website/lib/content-types.ts`: shared document/search/heading types.
- `apps/website/lib/content.test.ts`: registry, source, slug, search, and traversal tests.

### Documentation and search

- `apps/website/app/docs/page.tsx`: redirect to Getting Started.
- `apps/website/app/docs/[slug]/page.tsx`: static document routes.
- `apps/website/components/docs/docs-shell.tsx`: navigation, article, table of contents, source actions.
- `apps/website/components/docs/markdown-document.tsx`: safe repository Markdown rendering.
- `apps/website/components/docs/code-block.tsx`: accessible copy control.
- `apps/website/components/docs/docs.module.css`: three-column and responsive document layout.
- `apps/website/components/search/search-dialog.tsx`: keyboard-search overlay.
- `apps/website/components/search/search-dialog.test.tsx`: search behavior and focus tests.
- `apps/website/components/search/search.module.css`: modal and result styling.

### Home and public evidence

- `apps/website/public/cashu-fault-lab.png`: supplied Cashu pixel mark.
- `apps/website/lib/demo.ts`: strict parser and summary for the checked-in demo artifact.
- `apps/website/lib/demo.test.ts`: fixture-based demo summary tests.
- `apps/website/app/page.tsx`: problem-first home page.
- `apps/website/components/home/fault-timeline.tsx`: response-loss and convergence animation.
- `apps/website/components/home/evidence-report.tsx`: real demo invariant summary.
- `apps/website/components/home/home.module.css`: asymmetric hero and landing sections.

### Generated product pages

- `apps/website/lib/scenarios.ts`: recursive scenario discovery and source links.
- `apps/website/lib/scenarios.test.ts`: grouping, sorting, invalid-shape, and traversal tests.
- `apps/website/lib/release-status.ts`: checked-in policy and release-suite summary.
- `apps/website/lib/release-status.test.ts`: honest-gate wording and count tests.
- `apps/website/app/scenarios/page.tsx`: generated scenario catalog.
- `apps/website/app/architecture/page.tsx`: Cashu delivery and evidence flow.
- `apps/website/app/release-status/page.tsx`: developer-preview and gate requirements.
- `apps/website/app/content-pages.module.css`: scenario, architecture, and release layouts.

### Quality, metadata, and browser tests

- `apps/website/app/not-found.tsx`: branded recovery path.
- `apps/website/app/sitemap.ts`: static route sitemap.
- `apps/website/app/robots.ts`: crawler policy.
- `apps/website/app/manifest.ts`: web app metadata.
- `apps/website/app/icon.png`: favicon generated from the supplied Cashu mark.
- `apps/website/app/opengraph-image.tsx`: purple/sand fault-timeline social image.
- `apps/website/e2e/portal.spec.ts`: responsive, keyboard, reduced-motion, link, and axe tests.
- `apps/website/e2e/screenshots/`: ignored local screenshots created during verification.

---

### Task 1: Scaffold the workspace application and brand shell

**Files:**

- Create: `apps/website/package.json`
- Create: `apps/website/next.config.mjs`
- Create: `apps/website/tsconfig.json`
- Create: `apps/website/next-env.d.ts`
- Create: `apps/website/vitest.config.ts`
- Create: `apps/website/test/setup.ts`
- Create: `apps/website/app/layout.tsx`
- Create: `apps/website/app/page.tsx`
- Create: `apps/website/app/globals.css`
- Create: `apps/website/components/portal-shell.tsx`
- Create: `apps/website/components/site-header.tsx`
- Create: `apps/website/components/site-header.module.css`
- Create: `apps/website/test/shell.test.tsx`
- Modify: `package.json`
- Modify: `turbo.json`
- Modify: `.gitignore`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: the `@cashu-fault-lab/website` workspace with `dev`, `build`, `test`, `typecheck`, and `test:e2e` scripts.
- Produces: `SiteHeader({ onOpenSearch?: () => void })`, which receives the global search action from `PortalShell`.
- Produces: a temporary `PortalShell` that renders the header and children; Task 3 adds its search records and dialog state.
- Consumes: the repository's existing Node 24 and pnpm 11 toolchain.

- [ ] **Step 1: Add the package manifest, strict configs, and failing shell test**

Create `apps/website/package.json` with exact pinned dependencies:

```json
{
  "name": "@cashu-fault-lab/website",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@fontsource/archivo-black": "5.3.0",
    "@fontsource/ibm-plex-mono": "5.3.0",
    "@fontsource-variable/ibm-plex-sans": "5.3.0",
    "github-slugger": "2.0.0",
    "next": "16.2.12",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-markdown": "10.1.0",
    "rehype-pretty-code": "0.14.5",
    "rehype-slug": "6.0.0",
    "remark-gfm": "4.0.1",
    "shiki": "4.3.1"
  },
  "devDependencies": {
    "@axe-core/playwright": "4.12.1",
    "@playwright/test": "1.62.0",
    "@testing-library/jest-dom": "7.0.0",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.1",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "jsdom": "30.0.0",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

Create a strict `tsconfig.json`, `next-env.d.ts`, `next.config.mjs`, and `vitest.config.ts`. The Vitest configuration must use `jsdom`, load `test/setup.ts`, and include `**/*.test.ts?(x)`.

Write `test/shell.test.tsx` first:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteHeader } from "../components/site-header";

describe("SiteHeader", () => {
  it("exposes the primary developer navigation", () => {
    render(<SiteHeader />);
    expect(screen.getByRole("link", { name: "Cashu Fault Lab" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "/docs/getting-started",
    );
    expect(screen.getByRole("link", { name: "Scenarios" })).toHaveAttribute(
      "href",
      "/scenarios",
    );
    expect(screen.getByRole("link", { name: "Release status" })).toHaveAttribute(
      "href",
      "/release-status",
    );
  });
});
```

- [ ] **Step 2: Install and verify the shell test fails**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm install
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test
```

Expected: dependency installation updates `pnpm-lock.yaml`; Vitest fails because `components/site-header.tsx` does not exist.

- [ ] **Step 3: Implement the global shell**

Implement `SiteHeader` with Home, Docs, CLI, Scenarios, Adapters, Architecture, Release status, GitHub, a search button, and a mobile navigation disclosure. Use semantic `<header>`, `<nav aria-label="Primary">`, and buttons with explicit accessible labels.

Add these exact global tokens to `app/globals.css`:

```css
:root {
  --purple-950: #2b0c4a;
  --purple-700: #5b2099;
  --purple-500: #7f38ca;
  --sand-500: #dcc099;
  --sand-300: #e9d4ae;
  --sand-100: #f6ebd6;
  --content-width: 1180px;
  --docs-width: 1420px;
  --radius-sm: 6px;
  --radius-md: 12px;
  --shadow-line: 0 0 0 1px color-mix(in srgb, var(--sand-500) 34%, transparent);
}
```

Import Archivo Black, IBM Plex Sans Variable, and IBM Plex Mono from their Fontsource packages in `app/layout.tsx`. The root layout wraps its route children in `PortalShell`; the temporary shell adds a skip link, `SiteHeader`, `<main id="main-content">`, and a small footer stating “Experimental developer preview.”

The temporary `app/page.tsx` must render:

```tsx
export default function HomePage() {
  return (
    <section aria-labelledby="home-title">
      <p>Cashu delivery fault injection and recovery evidence</p>
      <h1 id="home-title">Make Cashu delivery fail safely.</h1>
      <code>pnpm lab demo</code>
    </section>
  );
}
```

Modify root `package.json` with:

```json
{
  "website:dev": "pnpm --filter @cashu-fault-lab/website dev",
  "website:build": "pnpm --filter @cashu-fault-lab/website build",
  "website:test": "pnpm --filter @cashu-fault-lab/website test",
  "website:test:e2e": "pnpm --filter @cashu-fault-lab/website test:e2e"
}
```

Extend `turbo.json` build outputs to include `".next/**"` and `"!.next/cache/**"` alongside `"dist/**"`. Add `.next/`, `.vercel/`, `playwright-report/`, and `test-results/` to `.gitignore`.

- [ ] **Step 4: Run focused shell checks**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website typecheck
```

Expected: the shell test passes and TypeScript reports no errors.

- [ ] **Step 5: Commit the scaffold**

```bash
git add package.json pnpm-lock.yaml turbo.json .gitignore apps/website
git commit -m "feat: scaffold Cashu Fault Lab website"
```

---

### Task 2: Build the canonical content engine

**Files:**

- Create: `apps/website/lib/content-types.ts`
- Create: `apps/website/lib/content-registry.ts`
- Create: `apps/website/lib/repository.ts`
- Create: `apps/website/lib/markdown.ts`
- Create: `apps/website/lib/content.test.ts`

**Interfaces:**

- Produces: `DocumentDefinition`, `DocumentPage`, `DocumentHeading`, and `SearchRecord`.
- Produces: `getAllDocuments(): Promise<DocumentPage[]>`.
- Produces: `getDocument(slug: string): Promise<DocumentPage | undefined>`.
- Produces: `getSearchRecords(): Promise<SearchRecord[]>`.
- Produces: `sourceUrl(path: string, action: "view" | "edit"): string`.
- Consumes: canonical files under the repository root.

- [ ] **Step 1: Define types, registry expectations, and failing tests**

Define:

```ts
export interface DocumentDefinition {
  slug: string;
  sourcePath: string;
  title: string;
  description: string;
  group: "Start" | "Operate" | "Integrate" | "Understand" | "Release";
  order: number;
}

export interface DocumentHeading {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface DocumentPage extends DocumentDefinition {
  markdown: string;
  headings: DocumentHeading[];
  viewUrl: string;
  editUrl: string;
  previous?: Pick<DocumentDefinition, "slug" | "title">;
  next?: Pick<DocumentDefinition, "slug" | "title">;
}

export interface SearchRecord {
  id: string;
  title: string;
  description: string;
  href: string;
  text: string;
}
```

Register the eight approved routes and source files from the design specification. Write tests that assert:

```ts
it("uses unique routes and existing canonical sources", async () => {
  expect(new Set(CONTENT_REGISTRY.map((item) => item.slug)).size).toBe(
    CONTENT_REGISTRY.length,
  );
  await expect(validateContentRegistry()).resolves.toEqual([]);
});

it("deduplicates GitHub-style heading slugs outside code fences", () => {
  expect(
    extractHeadings("## Retry\n```md\n## ignored\n```\n## Retry\n### NUT-19"),
  ).toEqual([
    { depth: 2, id: "retry", text: "Retry" },
    { depth: 2, id: "retry-1", text: "Retry" },
    { depth: 3, id: "nut-19", text: "NUT-19" },
  ]);
});

it("rejects paths outside the repository", () => {
  expect(() => resolveRepositoryPath("../secret.env")).toThrow(
    "Repository content path escapes the project root",
  );
});
```

- [ ] **Step 2: Run the content tests and observe failure**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test -- lib/content.test.ts
```

Expected: failure because registry, repository, and Markdown functions do not exist.

- [ ] **Step 3: Implement safe repository resolution and document loading**

`repository.ts` must resolve the root with `path.resolve(process.cwd(), "../..")` when running in `apps/website` and `process.cwd()` when the root `package.json` name is `cashu-fault-lab`. It must use `path.relative` and reject values beginning with `..` or resolving as absolute relatives.

`markdown.ts` must:

- ignore headings inside backtick and tilde fences;
- use `GithubSlugger` for stable duplicate IDs;
- strip links, emphasis, code ticks, and trailing heading markers from heading text;
- sort registry entries by `order`;
- read files as UTF-8;
- create exact GitHub URLs under `https://github.com/GautamBytes/cashu-fault-lab/blob/main/` and `/edit/main/`;
- normalize searchable text without evaluating HTML.

`getSearchRecords()` must create one document record plus one record per heading. Heading records link to `/docs/<slug>#<heading-id>`.

- [ ] **Step 4: Run content tests and type checking**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test -- lib/content.test.ts
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website typecheck
```

Expected: all content tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the content engine**

```bash
git add apps/website/lib
git commit -m "feat: generate website content from repository docs"
```

---

### Task 3: Render docs and add keyboard search

**Files:**

- Create: `apps/website/app/docs/page.tsx`
- Create: `apps/website/app/docs/[slug]/page.tsx`
- Create: `apps/website/components/docs/docs-shell.tsx`
- Create: `apps/website/components/docs/markdown-document.tsx`
- Create: `apps/website/components/docs/code-block.tsx`
- Create: `apps/website/components/docs/docs.module.css`
- Create: `apps/website/components/search/search-dialog.tsx`
- Create: `apps/website/components/search/search-dialog.test.tsx`
- Create: `apps/website/components/search/search.module.css`
- Modify: `apps/website/components/portal-shell.tsx`
- Modify: `apps/website/app/layout.tsx`
- Modify: `apps/website/components/site-header.tsx`

**Interfaces:**

- Consumes: `getDocument`, `getAllDocuments`, `getSearchRecords`.
- Produces: static params `{ slug: string }[]` for all registered documents.
- Produces: `SearchDialog({ open, onOpenChange, records })`.
- Produces: `PortalShell({ records, children })`, which owns search state and the `Cmd/Ctrl + K` listener.
- Produces: safe Markdown rendering with GFM, stable heading IDs, monochrome Shiki tokens, and code copying.

- [ ] **Step 1: Write failing search and document tests**

The search test must verify the keyboard and empty state:

```tsx
it("opens with the keyboard shortcut and filters canonical records", async () => {
  const user = userEvent.setup();
  render(
    <PortalShell
      records={[
        {
          id: "retry",
          title: "Retry convergence",
          description: "Invariant",
          href: "/docs/invariants#retry-convergence",
          text: "response loss exact payload",
        },
      ]}
    >
      <div>Page content</div>
    </PortalShell>,
  );

  await user.keyboard("{Meta>}k{/Meta}");
  expect(screen.getByRole("dialog", { name: "Search documentation" })).toBeVisible();
  await user.type(screen.getByRole("searchbox"), "response loss");
  expect(screen.getByRole("link", { name: /Retry convergence/ })).toHaveAttribute(
    "href",
    "/docs/invariants#retry-convergence",
  );
});

it("explains how to recover from an empty search", async () => {
  const user = userEvent.setup();
  render(
    <PortalShell records={[]}>
      <div>Page content</div>
    </PortalShell>,
  );
  await user.click(screen.getByRole("button", { name: "Search documentation" }));
  await user.type(screen.getByRole("searchbox"), "unknown");
  expect(screen.getByText("No matching documentation.")).toBeVisible();
  expect(screen.getByRole("link", { name: "Browse scenarios" })).toHaveAttribute(
    "href",
    "/scenarios",
  );
});
```

Import `userEvent` from the already pinned `@testing-library/user-event` 14.6.1 dependency.

- [ ] **Step 2: Run the focused tests and observe failure**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test -- components/search/search-dialog.test.tsx
```

Expected: failure because `SearchDialog` does not exist.

- [ ] **Step 3: Implement document pages and safe Markdown**

`app/docs/page.tsx` redirects to `/docs/getting-started`.

`app/docs/[slug]/page.tsx` must:

- export `dynamicParams = false`;
- return all registered slugs from `generateStaticParams`;
- call `notFound()` for unknown slugs;
- derive route metadata from the document definition;
- render `DocsShell`.

`MarkdownDocument` must configure:

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[
    rehypeSlug,
    [
      rehypePrettyCode,
      {
        theme: "css-variables",
        keepBackground: false,
      },
    ],
  ]}
  skipHtml
  components={{
    pre: CodeBlock,
    a: SafeMarkdownLink,
  }}
>
  {markdown}
</ReactMarkdown>
```

Set every Shiki CSS variable to a purple or sand token. `SafeMarkdownLink` must add `target="_blank"` and `rel="noreferrer noopener"` only for external links.

`DocsShell` must render:

- grouped left navigation;
- article title and description;
- “View source” and “Edit on GitHub” links;
- article Markdown;
- right table of contents;
- previous and next document links.

On mobile, place a compact “On this page” block before the article body.

- [ ] **Step 4: Implement search, copy, and shell integration**

`PortalShell` is a client component that owns `open`, renders `SiteHeader`, `SearchDialog`, page children, and the footer, and:

- listens for `Cmd/Ctrl + K`;
- passes `onOpenSearch={() => setOpen(true)}` to `SiteHeader`;
- passes `open`, `onOpenChange={setOpen}`, and records to `SearchDialog`;
- prevents the shortcut when focus is inside an input, textarea, or content-editable field.

`SearchDialog`:

- closes on Escape;
- moves focus to the search box when opened;
- restores focus to the trigger when closed;
- ranks title matches before body matches;
- limits results to eight;
- contains no network calls;
- renders the supplied Cashu mark as a small decorative image in the no-results state.

`CodeBlock` is a client component using a `<pre ref>` and:

```ts
const text = preRef.current?.innerText ?? "";
await navigator.clipboard.writeText(text);
setCopied(true);
window.setTimeout(() => setCopied(false), 1600);
```

It renders the button label as “Copy code” and changes it to “Copied” after success.

Load `getSearchRecords()` in `app/layout.tsx` and wrap route children with `<PortalShell records={records}>`.

- [ ] **Step 5: Run docs/search checks**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website typecheck
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website build
```

Expected: tests and type checking pass; Next lists all eight `/docs/<slug>` routes as static output.

- [ ] **Step 6: Commit docs and search**

```bash
git add apps/website pnpm-lock.yaml
git commit -m "feat: add repository-backed docs and search"
```

---

### Task 4: Build the Cashu home page and evidence story

**Files:**

- Create: `apps/website/public/cashu-fault-lab.png`
- Create: `apps/website/app/icon.png`
- Create: `apps/website/lib/demo.ts`
- Create: `apps/website/lib/demo.test.ts`
- Create: `apps/website/components/home/fault-timeline.tsx`
- Create: `apps/website/components/home/evidence-report.tsx`
- Create: `apps/website/components/home/home.module.css`
- Modify: `apps/website/app/page.tsx`

**Interfaces:**

- Produces: `getDemoSummary(): Promise<DemoSummary>`.
- Produces: `DemoSummary` with scenario, seed, status, command count, timeline count, and invariant status counts.
- Consumes: `docs/examples/v0.1.0-demo.json`.

- [ ] **Step 1: Copy the approved mark and write failing demo tests**

Copy the supplied image without transforming it:

```bash
cp /var/folders/22/w1y7jxm926g_k50fq9wt1j5m0000gn/T/codex-clipboard-5f1bdb64-dd86-41b2-9b4c-5649352aec80.png apps/website/public/cashu-fault-lab.png
cp /var/folders/22/w1y7jxm926g_k50fq9wt1j5m0000gn/T/codex-clipboard-5f1bdb64-dd86-41b2-9b4c-5649352aec80.png apps/website/app/icon.png
```

Write:

```ts
it("summarizes the reviewed demo artifact without exposing commands", async () => {
  const summary = await getDemoSummary();
  expect(summary).toMatchObject({
    scenarioId: "http-response-lost",
    seed: "cashu-fault-lab-v0.1.0-demo",
    status: "passed",
    commandCount: 3,
    timelineCount: 13,
    invariantCount: 18,
  });
  expect(JSON.stringify(summary)).not.toContain("proofSecret");
});

it("counts every invariant state", async () => {
  const summary = await getDemoSummary();
  expect(
    summary.invariantCounts.passed +
      summary.invariantCounts.failed +
      summary.invariantCounts.not_observable +
      summary.invariantCounts.not_applicable,
  ).toBe(18);
});
```

- [ ] **Step 2: Run the demo test and observe failure**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test -- lib/demo.test.ts
```

Expected: failure because `getDemoSummary` does not exist.

- [ ] **Step 3: Implement the strict artifact summary**

Parse JSON as `unknown`. Accept only:

- `schemaVersion === 2`;
- string `scenarioId`, `seed`, and `status`;
- arrays `commands`, `timeline`, and `invariants`;
- invariant statuses in `passed | failed | not_observable | not_applicable`.

Return counts and invariant `{ id, status, confidence, reason }` records only. Do not return commands, timeline payloads, capabilities, component versions, image digests, or arbitrary evidence values.

- [ ] **Step 4: Implement the distinctive home page**

The hero must contain:

```tsx
<p>Cashu delivery fault injection and recovery evidence</p>
<h1>Make Cashu delivery fail safely.</h1>
<p>
  Inject response loss, retries, duplicates, and process crashes across real wallets
  and mints—then prove every implementation converges.
</p>
```

Render:

- “Run the deterministic demo” linking to Getting Started;
- “View on GitHub” linking to the repository;
- a command block containing `pnpm lab demo`;
- the supplied pixel mark;
- `FaultTimeline`;
- `EvidenceReport` from the real demo summary;
- “What gets tested,” delivery-v1 flow, invariant coverage, adapters, security boundary, release status, and contribution sections.

`FaultTimeline` uses six labeled states:

1. Reserve proofs
2. Send delivery
3. Response lost
4. Exact retry
5. Recover proofs
6. One durable credit

CSS animation must reuse one `deliveryTrace` keyframe sequence, pause at convergence, and switch to a completed static vertical flow under reduced motion. Status differences use icons and border patterns, never additional hues.

- [ ] **Step 5: Run home checks**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website typecheck
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website build
```

Expected: demo tests pass and the home route builds statically.

- [ ] **Step 6: Commit the home experience**

```bash
git add apps/website
git commit -m "feat: tell the Cashu delivery fault story"
```

---

### Task 5: Generate scenarios, architecture, and honest release status

**Files:**

- Create: `apps/website/lib/scenarios.ts`
- Create: `apps/website/lib/scenarios.test.ts`
- Create: `apps/website/lib/release-status.ts`
- Create: `apps/website/lib/release-status.test.ts`
- Create: `apps/website/app/scenarios/page.tsx`
- Create: `apps/website/app/architecture/page.tsx`
- Create: `apps/website/app/release-status/page.tsx`
- Create: `apps/website/app/content-pages.module.css`
- Modify: `apps/website/app/page.tsx`

**Interfaces:**

- Produces: `getScenarioGroups(): Promise<ScenarioGroup[]>`.
- Produces: `getReleaseStatus(): Promise<ReleaseStatus>`.
- Consumes: `scenarios/**/*.json`, `spec/release-policy.json`, and `spec/release-suite.json`.

- [ ] **Step 1: Write failing generated-content tests**

Define:

```ts
export interface ScenarioCard {
  slug: string;
  name: string;
  description: string;
  family: string;
  commandCount: number;
  sourceUrl: string;
}

export interface ScenarioGroup {
  family: string;
  scenarios: ScenarioCard[];
}

export interface ReleaseStatus {
  label: "Experimental developer preview";
  profile: string;
  policySchemaVersion: number;
  releaseSuiteScenarioCount: number;
  minimumQualifyingPairs: number;
  minimumDistinctMints: number;
  currentQualifyingPairs: 0;
  currentDistinctMints: 0;
  blockers: string[];
}
```

Tests must assert:

```ts
it("discovers and groups every checked-in scenario", async () => {
  const groups = await getScenarioGroups();
  const all = groups.flatMap((group) => group.scenarios);
  expect(all).toHaveLength(32);
  expect(all.find((item) => item.slug === "retry/response-lost")).toMatchObject({
    name: "http-response-lost",
    family: "retry",
    commandCount: 3,
  });
});

it("reports the strict gate without turning requirements into passes", async () => {
  await expect(getReleaseStatus()).resolves.toMatchObject({
    label: "Experimental developer preview",
    profile: "delivery-v1",
    releaseSuiteScenarioCount: 13,
    minimumQualifyingPairs: 2,
    minimumDistinctMints: 2,
    currentQualifyingPairs: 0,
    currentDistinctMints: 0,
  });
});
```

- [ ] **Step 2: Run generated-content tests and observe failure**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test -- lib/scenarios.test.ts lib/release-status.test.ts
```

Expected: failure because both loaders are missing.

- [ ] **Step 3: Implement scenario and release loaders**

Recursively discover `.json` files under `scenarios`, sort family and source path, and validate that each file has a non-empty `name`, `description`, and `commands` array. Source links point to the exact GitHub path.

Read release values directly from policy/suite JSON. The four current values are intentionally literal zeros because the repository contains no signed qualifying matrix artifact. Add these blockers exactly:

- “Independent wallet receiver”
- “Independent mint and ledger evidence authorities”
- “Second qualifying implementation pair”
- “Second distinct mint identity”
- “External integration and review”

The loader must not infer a passing release from test counts or the demo artifact.

- [ ] **Step 4: Implement the generated pages**

`/scenarios` groups cards by the actual top-level directory and includes source links and the exact run form:

```text
pnpm lab run <scenario-slug> --seed demo
```

`/architecture` renders a semantic six-stage flow:

```text
Durable sender → HTTP/Nostr faults → Durable receiver
       ↓                                  ↓
 exact payload                      mint recovery
       └──────── independent oracle ────────┘
                            ↓
                   JSON/JUnit/HTML evidence
```

`/release-status` renders required versus current values and explains why the strict gate failing is a safety feature. It links to release notes, checklist, policy source, and suite source.

Update the home page to consume `getReleaseStatus()` for its release section so the same checked-in policy values drive both surfaces.

- [ ] **Step 5: Run generated-page checks**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website build
```

Expected: 32 scenarios appear in tests and all three product pages build statically.

- [ ] **Step 6: Commit generated product pages**

```bash
git add apps/website
git commit -m "feat: expose scenarios architecture and release status"
```

---

### Task 6: Add metadata, accessibility, and responsive browser gates

**Files:**

- Create: `apps/website/app/not-found.tsx`
- Create: `apps/website/app/sitemap.ts`
- Create: `apps/website/app/robots.ts`
- Create: `apps/website/app/manifest.ts`
- Create: `apps/website/app/opengraph-image.tsx`
- Create: `apps/website/playwright.config.ts`
- Create: `apps/website/e2e/portal.spec.ts`
- Modify: `apps/website/app/layout.tsx`
- Modify: responsive CSS modules as browser failures identify exact defects

**Interfaces:**

- Produces: canonical metadata for every public route.
- Produces: Playwright projects `desktop-chromium` at 1440×900 and `mobile-chromium` at 390×844.
- Consumes: the production website server at `http://127.0.0.1:4317`.

- [ ] **Step 1: Write failing browser assertions**

Configure Playwright:

```ts
export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/website",
  use: {
    baseURL: "http://127.0.0.1:4317",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm build && PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm start --port 4317",
    port: 4317,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: "desktop-chromium", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile-chromium", use: { viewport: { width: 390, height: 844 } } },
  ],
});
```

Write tests that:

- find exactly one visible `h1` on home;
- run `AxeBuilder({ page }).analyze()` and assert zero serious/critical violations;
- press `Meta+k` or `Control+k`, search `NUT-19`, and navigate to a docs heading;
- open mobile navigation and reach Scenarios;
- emulate reduced motion and verify the timeline has `data-motion="reduced"`;
- assert `document.documentElement.scrollWidth <= window.innerWidth`;
- verify code blocks do not create page overflow;
- verify the 404 offers “Search documentation” and “Getting started”;
- take `home-desktop.png`, `docs-desktop.png`, `home-mobile.png`, and `docs-mobile.png` into `e2e/screenshots`.

- [ ] **Step 2: Run browser tests and observe failures**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test:e2e
```

Expected: failures for missing metadata routes, reduced-motion signal, and any unresolved accessibility/responsive behavior.

- [ ] **Step 3: Implement metadata and recovery routes**

Add:

- canonical `metadataBase` from `VERCEL_PROJECT_PRODUCTION_URL`, falling back to `VERCEL_URL`, then `http://localhost:3000`; prepend `https://` to Vercel host values;
- title template `%s | Cashu Fault Lab`;
- honest description containing “experimental developer preview”;
- a `SoftwareApplication` JSON-LD object on home with `applicationCategory: "DeveloperApplication"`, `operatingSystem: "Linux, macOS, Windows with Docker"`, the MIT license URL, and the GitHub repository URL; serialize it with `<` escaped as `\u003c`;
- sitemap entries for home, scenarios, architecture, release status, and all docs;
- robots allowing public routes;
- manifest with purple/sand theme/background colors;
- an `ImageResponse` Open Graph image with the headline and fault timeline;
- a 404 with search, Getting Started, Scenarios, and GitHub actions.

The Open Graph image must use only the six approved purple/sand tokens.

- [ ] **Step 4: Resolve accessibility and responsive failures**

Use semantic headings and landmarks, keep touch controls at least 44×44 CSS pixels, ensure code blocks use local horizontal scrolling, and expose `data-motion="reduced"` from a `matchMedia("(prefers-reduced-motion: reduce)")` client hook.

Do not suppress axe rules. Fix every serious or critical finding at the source.

- [ ] **Step 5: Run the full website quality gate**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website typecheck
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website build
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm --filter @cashu-fault-lab/website test:e2e
```

Expected: unit, type, build, desktop, mobile, accessibility, keyboard, and overflow checks pass; four screenshots are written.

- [ ] **Step 6: Commit quality and metadata**

```bash
git add apps/website
git commit -m "feat: harden website accessibility and metadata"
```

---

### Task 7: Configure Vercel, verify the monorepo, and deploy a preview

**Files:**

- Create: `.vercelignore`
- Create: `vercel.json`
- Modify: `README.md`

**Interfaces:**

- Consumes: repository-root deployment and `@cashu-fault-lab/website`.
- Produces: one newly created Vercel project and one preview URL.
- Produces: local contributor commands documented in canonical `README.md`.

- [ ] **Step 1: Write the deployment contract**

Create `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm --filter @cashu-fault-lab/website build",
  "outputDirectory": "apps/website/.next"
}
```

Create `.vercelignore`:

```text
.git
.worktrees
.pnpm-store
.cashu-fault-lab
artifacts
test-results
playwright-report
**/node_modules
**/.turbo
**/dist
```

Add a `Website` section to `README.md` with:

```bash
pnpm website:dev
pnpm website:test
pnpm website:build
pnpm website:test:e2e
```

State that the site reads `README.md`, `docs/`, `spec/`, `scenarios/`, and the reviewed demo artifact during its build. Preview URLs are deployment outputs returned to the user rather than committed as canonical project URLs.

- [ ] **Step 2: Verify a clean reproducible install and repository gates**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm install --frozen-lockfile
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm format:check
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm typecheck
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm test
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm build
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm website:test:e2e
```

Expected: lockfile install, formatting, all unit tests, all package types, all builds, and website browser tests pass.

- [ ] **Step 3: Visually inspect local desktop and mobile output**

Start:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm website:dev
```

Open `http://127.0.0.1:3000` with the connected browser. Capture and inspect home, docs, scenarios, architecture, and release status at 1440×900 and 390×844. Correct clipped text, weak hierarchy, accidental third hues, spacing defects, and unclear focus states. Re-run the website test, type, build, and E2E gates after any correction.

- [ ] **Step 4: Commit deployment configuration**

```bash
git add .vercelignore vercel.json README.md
git commit -m "feat: configure Cashu Fault Lab website deployment"
```

- [ ] **Step 5: Create the Vercel project and deploy the preview**

Because the Vercel CLI is absent, run the approved fallback from the repository root with a 10-minute timeout:

```bash
bash /Users/gautammanch/.codex/skills/vercel-deploy/scripts/deploy.sh /Users/gautammanch/Developer/cashu-fault-lab/.worktrees/release-gate-integrity
```

Expected: JSON containing `previewUrl` and `claimUrl`. Do not fetch the deployed URL after deployment; local production-build and browser evidence are the deployment verification.

- [ ] **Step 6: Run final source-state checks**

Run:

```bash
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm format:check
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm website:test
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm website:build
git diff --check
git status --short
```

Expected: all checks pass, the worktree is clean, and the final response can return `previewUrl` plus `claimUrl`.

---

## Final acceptance checklist

- [ ] Home explains the ambiguous-delivery problem and shows `pnpm lab demo` above the fold.
- [ ] Fault timeline demonstrates response loss, exact retry, recovery, and one durable credit.
- [ ] The checked-in demo artifact drives the evidence report.
- [ ] Eight canonical Markdown sources render as static, searchable documentation.
- [ ] Every document exposes source and edit links.
- [ ] Thirty-two scenario JSON files generate the scenario catalog.
- [ ] Architecture and release pages distinguish evidence from certification.
- [ ] Strict status remains 0/2 qualifying pairs and 0/2 distinct mints.
- [ ] The supplied Cashu image appears in the header, favicon source, and restrained empty state.
- [ ] Purple and sand are the only hue families.
- [ ] Desktop and mobile have no page-level overflow.
- [ ] Keyboard search, mobile navigation, code copy, focus, and reduced motion work.
- [ ] Axe reports no serious or critical violations.
- [ ] Unit, type, build, repository, and browser gates pass.
- [ ] A new Vercel project returns a preview URL and claim URL.
- [ ] Canonical repository docs explain the website workflow without pinning an ephemeral preview URL.
