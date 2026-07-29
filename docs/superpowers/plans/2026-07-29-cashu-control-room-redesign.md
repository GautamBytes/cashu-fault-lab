# Cashu Control Room Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the complete Cashu Fault Lab portal as a dense, full-screen Cashu developer tool while simplifying global navigation and preserving all existing content and behavior.

**Architecture:** Keep the existing Next.js App Router, content readers, search, and page components. Establish the dark Cashu Control Room tokens and shell globally, then update the header, home modules, docs shell, and generated content pages to consume that shared system. Add focused unit assertions for information architecture and Playwright assertions for first-viewport density, responsive navigation, accessibility, and overflow.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 7, CSS Modules, Vitest, Testing Library, Playwright, Axe

## Global Constraints

- Apply the redesign to every route in `apps/website`.
- Use Ink `#09070D`, Control surface `#121018`, Elevated surface `#1A1422`, Deep plum `#2B0C4A`, Cashu violet `#7F38CA`, Electric violet `#A855F7`, Warm sand `#DCC099`, Light sand `#F6EBD6`, and Muted text `#A99CAE`.
- Keep Archivo Black for display, IBM Plex Sans Variable for body, and IBM Plex Mono for utility text.
- Keep button radii at 6 pixels or less.
- Global navigation contains Home, Docs, Release status, and Search.
- Documentation navigation contains CLI and Architecture.
- Scenarios are promoted on Home and removed from global navigation.
- GitHub remains in the hero and source actions and leaves global navigation.
- Preserve canonical Markdown, search behavior, release logic, evidence computation, semantic landmarks, reduced-motion behavior, and 44-pixel mobile targets.
- No route may create page-level horizontal overflow.
- At 1440×900, the hero shows its primary command and reveals the start of the fault trace.

---

### Task 1: Simplify global navigation and expand the docs rail

**Files:**

- Modify: `apps/website/components/site-header.tsx`
- Modify: `apps/website/components/docs/docs-shell.tsx`
- Modify: `apps/website/test/shell.test.tsx`
- Modify: `apps/website/app/content-pages.test.tsx`

**Interfaces:**

- Consumes: existing `SiteHeaderProps`, `DocumentPage[]`, and `/architecture` route.
- Produces: global `navigation` with Home, Docs, Release status; docs navigation link named Architecture pointing to `/architecture`.

- [ ] **Step 1: Replace the shell navigation expectations with the approved information architecture**

```tsx
it('exposes the compact primary navigation', () => {
  render(<SiteHeader />);

  expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
  expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute(
    'href',
    '/docs/getting-started',
  );
  expect(screen.getByRole('link', { name: 'Release status' })).toHaveAttribute(
    'href',
    '/release-status',
  );
  expect(screen.queryByRole('link', { name: 'CLI' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Scenarios' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Architecture' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'GitHub' })).not.toBeInTheDocument();
});
```

Add a content-page assertion that the docs navigation exposes Architecture:

```tsx
expect(screen.getByRole('navigation', { name: 'Documentation' })).toHaveTextContent('Architecture');
expect(screen.getByRole('link', { name: 'Architecture' })).toHaveAttribute('href', '/architecture');
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test -- test/shell.test.tsx app/content-pages.test.tsx
```

Expected: FAIL because the global header still contains CLI, Scenarios, Adapters, Architecture, and GitHub, and the docs rail has no Architecture link.

- [ ] **Step 3: Reduce `navigation` and add the Architecture docs-rail item**

Use this global navigation:

```tsx
const navigation = [
  { href: '/', label: 'Home' },
  { href: '/docs/getting-started', label: 'Docs' },
  { href: '/release-status', label: 'Release status' },
];
```

Remove the standalone GitHub anchor from `SiteHeader`. In `DocumentationNavigation`, render the
Architecture route after the documents in the `Understand` group:

```tsx
{
  group === 'Understand' ? (
    <li>
      <a href="/architecture">Architecture</a>
    </li>
  ) : null;
}
```

- [ ] **Step 4: Run the focused tests and confirm they pass**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test -- test/shell.test.tsx app/content-pages.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the information architecture**

```bash
git add apps/website/components/site-header.tsx apps/website/components/docs/docs-shell.tsx apps/website/test/shell.test.tsx apps/website/app/content-pages.test.tsx
git commit -m "feat(website): simplify portal navigation"
```

---

### Task 2: Establish the dark portal shell and compact header

**Files:**

- Modify: `apps/website/app/globals.css`
- Modify: `apps/website/components/portal-shell.tsx`
- Modify: `apps/website/components/site-header.module.css`
- Modify: `apps/website/components/search/search.module.css`
- Modify: `apps/website/app/not-found.module.css`
- Modify: `apps/website/app/manifest.ts`
- Modify: `apps/website/app/site-metadata.test.ts`

**Interfaces:**

- Consumes: current CSS custom properties and existing semantic shell.
- Produces: shared dark tokens including `--ink`, `--control-surface`, `--elevated-surface`, `--muted-text`, `--hairline`, and `--shell-width`; sticky compact header and dark footer.

- [ ] **Step 1: Add a metadata test for the dark application shell**

Update the manifest expectation:

```tsx
expect(manifest).toMatchObject({
  background_color: '#09070d',
  theme_color: '#2b0c4a',
});
```

- [ ] **Step 2: Run the metadata test and confirm it fails**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test -- app/site-metadata.test.ts
```

Expected: FAIL because the manifest still declares the light sand background.

- [ ] **Step 3: Define the shared tokens and shell**

In `globals.css`, replace the light default page surface with:

```css
:root {
  --ink: #09070d;
  --control-surface: #121018;
  --elevated-surface: #1a1422;
  --purple-950: #2b0c4a;
  --purple-700: #5b2099;
  --purple-500: #7f38ca;
  --purple-electric: #a855f7;
  --sand-500: #dcc099;
  --sand-300: #e9d4ae;
  --sand-100: #f6ebd6;
  --muted-text: #a99cae;
  --hairline: rgb(220 192 153 / 16%);
  --shell-width: 97.5rem;
  --docs-width: 95rem;
  --radius-sm: 4px;
  --radius-md: 6px;
  color-scheme: dark;
}

html {
  background: var(--ink);
}

body {
  background: var(--ink);
  color: var(--sand-100);
}
```

Keep the existing font declarations, reset, skip link, and responsive behavior. Change `main`,
footer, selection, inline code, and focus colors to use the new surfaces. Remove negative page
margins that depend on the old light shell.

Update `portal-shell.tsx` footer copy wrapper only as needed for styling; do not change its text.
Restyle the search dialog and not-found page with Control and Elevated surfaces.

In `manifest.ts`, set:

```ts
background_color: '#09070d',
theme_color: '#2b0c4a',
```

- [ ] **Step 4: Rebuild the header as a compact translucent control bar**

Use `position: sticky`, `top: 0`, `z-index: 50`, a 68-pixel desktop height, and a
`rgb(9 7 13 / 88%)` background with `backdrop-filter: blur(18px)`. Use the shared shell width.
Keep a solid Ink fallback. Reduce the mobile header to 60 pixels and keep every control at least
44 pixels.

- [ ] **Step 5: Run metadata and shell tests**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test -- app/site-metadata.test.ts test/shell.test.tsx components/search/search-dialog.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the shared shell**

```bash
git add apps/website/app/globals.css apps/website/components/portal-shell.tsx apps/website/components/site-header.module.css apps/website/components/search/search.module.css apps/website/app/not-found.module.css apps/website/app/manifest.ts apps/website/app/site-metadata.test.ts
git commit -m "feat(website): add Cashu control room shell"
```

---

### Task 3: Rebuild the hero and promote scenarios

**Files:**

- Modify: `apps/website/app/page.tsx`
- Create: `apps/website/components/home/hero-run-panel.tsx`
- Create: `apps/website/components/home/scenario-explorer.tsx`
- Modify: `apps/website/components/home/home.module.css`
- Modify: `apps/website/components/home/home.test.tsx`
- Modify: `apps/website/e2e/portal.spec.ts`

**Interfaces:**

- Consumes: `DemoSummary` returned by `getDemoSummary()` and scenario groups returned by `getScenarioGroups()`.
- Produces: `HeroRunPanel({ summary }: { summary: DemoSummary })` and `ScenarioExplorer({ groups }: { groups: ScenarioGroup[] })`.

- [ ] **Step 1: Add failing home tests for scenario discovery and GitHub placement**

Render `HomePage` with the existing async test pattern and assert:

```tsx
expect(screen.getByRole('link', { name: /View on GitHub/ })).toHaveAttribute(
  'href',
  'https://github.com/GautamBytes/cashu-fault-lab',
);
expect(screen.getByRole('heading', { name: 'Explore fault scenarios' })).toBeVisible();
expect(screen.getByRole('link', { name: 'Explore all scenarios' })).toHaveAttribute(
  'href',
  '/scenarios',
);
```

Add a Playwright desktop assertion after `page.goto('/')`:

```ts
const hero = page.locator('section').first();
const heroBox = await hero.boundingBox();
const traceHeading = page.getByRole('heading', { name: /lost response/i });
const traceBox = await traceHeading.boundingBox();

expect(heroBox?.height).toBeLessThanOrEqual(820);
expect(traceBox?.y).toBeLessThan(900);
```

- [ ] **Step 2: Run the home tests and confirm they fail**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test -- components/home/home.test.tsx
```

Expected: FAIL because the home page has no scenario explorer.

- [ ] **Step 3: Add the run panel and scenario explorer**

`HeroRunPanel` shows the existing scenario ID, seed, command count, invariant count, and converged
status from `DemoSummary`. It uses semantic `<dl>` data and the existing Cashu image at 48×48.

`ScenarioExplorer` accepts the result of `getScenarioGroups()`, computes the total count, and
renders four family summaries followed by:

```tsx
<a className={styles.primaryAction} href="/scenarios">
  Explore all scenarios
</a>
```

Update `HomePage` to load all three inputs:

```tsx
const [summary, releaseStatus, scenarioGroups] = await Promise.all([
  getDemoSummary(),
  getReleaseStatus(),
  getScenarioGroups(),
]);
```

Place `HeroRunPanel` on the right side of the hero. Place `ScenarioExplorer` after
`EvidenceReport`.

- [ ] **Step 4: Implement the full-screen hero and fault-field**

Use a two-column hero with:

```css
.hero {
  min-height: calc(100svh - 4.25rem);
  padding: clamp(3rem, 6vh, 5rem) clamp(1rem, 4vw, 4rem) clamp(4.5rem, 8vh, 7rem);
}
```

Set the shell width to `min(100%, var(--shell-width))`. Build the fault-field from layered radial
and linear CSS gradients plus a masked grid. Do not add decorative orbs. Keep headline,
description, both actions, and command visible at 1440×900. Add a bottom trace preview that leaves
the next heading visible.

Use a violet gradient only on the primary action and live trace. Keep surrounding surfaces Ink,
Control, and Elevated.

- [ ] **Step 5: Run home unit tests**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test -- components/home/home.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the hero and scenario discovery**

```bash
git add apps/website/app/page.tsx apps/website/components/home/hero-run-panel.tsx apps/website/components/home/scenario-explorer.tsx apps/website/components/home/home.module.css apps/website/components/home/home.test.tsx apps/website/e2e/portal.spec.ts
git commit -m "feat(website): rebuild home control room hero"
```

---

### Task 4: Tighten evidence and the remaining home narrative

**Files:**

- Modify: `apps/website/components/home/evidence-report.tsx`
- Modify: `apps/website/components/home/fault-timeline.tsx`
- Modify: `apps/website/components/home/home.module.css`
- Modify: `apps/website/components/home/home.test.tsx`

**Interfaces:**

- Consumes: existing `DemoSummary`, release status, profile steps, and tested-fault content.
- Produces: the same accessible evidence list and six-stage timeline with denser dark layouts.

- [ ] **Step 1: Add a structural test that preserves the evidence contract**

Extend the evidence test:

```tsx
expect(screen.getByRole('list', { name: 'Invariant evidence states' })).toBeVisible();
expect(screen.getByText('18', { selector: 'dd, strong' })).toBeVisible();
expect(screen.getByRole('link', { name: /Inspect the reviewed artifact/ })).toBeVisible();
```

- [ ] **Step 2: Run the focused test before styling**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test -- components/home/home.test.tsx
```

Expected: PASS before the presentation refactor, establishing the contract.

- [ ] **Step 3: Recompose evidence without changing its data**

Move explanation, scenario metadata, and status into one top grid. Render aggregate counts in a
single four-column strip. Keep all 18 invariant items and transform the list into a two-column
desktop record grid with one column below 760 pixels. Remove the large empty explanatory column.

- [ ] **Step 4: Tighten the timeline and remaining sections**

Set home section padding to 64–96 pixels on desktop and 48–64 pixels on mobile. Use full-width
bands, shared hairlines, and no nested cards. Connect profile and coverage in one dark technical
band. Place adapters and security in a responsive two-column boundary band. Reduce the release
status section to a compact policy strip and contribution to one command-oriented row.

Keep `data-motion="reduced"` behavior and the six semantic timeline stages.

- [ ] **Step 5: Run the home tests**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test -- components/home/home.test.tsx
```

Expected: PASS with 18 invariant items and the existing reduced-motion signal intact.

- [ ] **Step 6: Commit the home narrative**

```bash
git add apps/website/components/home/evidence-report.tsx apps/website/components/home/fault-timeline.tsx apps/website/components/home/home.module.css apps/website/components/home/home.test.tsx
git commit -m "feat(website): tighten evidence and fault sections"
```

---

### Task 5: Apply the Control Room system to docs and generated content pages

**Files:**

- Modify: `apps/website/components/docs/docs.module.css`
- Modify: `apps/website/components/docs/code-block.tsx`
- Modify: `apps/website/components/docs/markdown-document.test.tsx`
- Modify: `apps/website/app/content-pages.module.css`
- Modify: `apps/website/app/not-found.module.css`

**Interfaces:**

- Consumes: existing `DocsShell`, Markdown rendering, scenario, architecture, release, and 404 markup.
- Produces: dark three-column docs shell, compact code controls, and shared dark generated-content surfaces.

- [ ] **Step 1: Add a code-copy accessible-name assertion**

In `markdown-document.test.tsx`, assert:

```tsx
expect(screen.getByRole('button', { name: 'Copy code' })).toBeVisible();
```

- [ ] **Step 2: Run the markdown test and record its current state**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test -- components/docs/markdown-document.test.tsx
```

Expected: PASS if the current label already matches; otherwise FAIL and use the next step to add the
exact label without changing copy behavior.

- [ ] **Step 3: Restyle the docs shell**

Use a `minmax(13rem, 16rem) minmax(0, 52rem) minmax(11rem, 14rem)` desktop grid inside the
95-rem docs shell. Give sidebars Control surfaces, a hairline edge, compact group spacing, and
sticky offsets below the header. Use an Elevated article surface with a readable 70–78ch content
measure. Keep tablet and mobile collapse behavior.

Restyle headings, links, tables, blockquotes, pagination, and mobile disclosures with the shared
tokens. Remove pale sand backgrounds.

- [ ] **Step 4: Refine code controls**

Keep the Shiki dark surface and local horizontal scrolling. Add a visible utility label derived
from available code metadata when the component already exposes it. Use a compact icon or
icon-plus-state copy button with `aria-label="Copy code"`, preserving the existing copied feedback.

- [ ] **Step 5: Restyle generated pages**

Replace light page heroes and long pale sections in `content-pages.module.css` with Ink, Control,
Elevated, and Deep plum bands. Reduce page hero minimum height from 34rem to a bounded 24–30rem.
Keep scenario cards as repeated records, but reduce their minimum height and padding. Keep
Architecture and Release status content, source links, and status semantics unchanged.

- [ ] **Step 6: Run docs and content tests**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test -- components/docs/markdown-document.test.tsx app/content-pages.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit docs and generated pages**

```bash
git add apps/website/components/docs/docs.module.css apps/website/components/docs/code-block.tsx apps/website/components/docs/markdown-document.test.tsx apps/website/app/content-pages.module.css apps/website/app/not-found.module.css
git commit -m "feat(website): redesign docs and content surfaces"
```

---

### Task 6: Verify the portal at production and real viewports

**Files:**

- Modify: `apps/website/e2e/portal.spec.ts`
- Modify: `apps/website/e2e/screenshots/home-desktop.png`
- Modify: `apps/website/e2e/screenshots/home-mobile.png`
- Modify: `apps/website/e2e/screenshots/docs-desktop.png`
- Modify: `apps/website/e2e/screenshots/docs-mobile.png`
- Modify: `apps/website/e2e/screenshots/home-user-viewport.png`
- Modify: `design-qa.md`

**Interfaces:**

- Consumes: completed portal and existing Playwright projects.
- Produces: current responsive screenshots and verification notes.

- [ ] **Step 1: Update the mobile navigation flow**

Replace the mobile menu scenario click with compact-navigation assertions:

```ts
await menu.click();
await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
await expect(page.getByRole('link', { name: 'Docs', exact: true })).toBeVisible();
await expect(page.getByRole('link', { name: 'Release status', exact: true })).toBeVisible();
await expect(page.getByRole('link', { name: 'Scenarios', exact: true })).toHaveCount(0);
await page.getByRole('link', { name: 'Docs', exact: true }).click();
```

Keep touch-target and docs disclosure assertions.

- [ ] **Step 2: Run all website unit tests**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test
```

Expected: all tests PASS.

- [ ] **Step 3: Run TypeScript and production build**

Run:

```bash
pnpm --filter @cashu-fault-lab/website typecheck
pnpm --filter @cashu-fault-lab/website build
```

Expected: both commands exit 0.

- [ ] **Step 4: Run Playwright**

Run:

```bash
pnpm --filter @cashu-fault-lab/website test:e2e
```

Expected: navigation, accessibility, overflow, reduced motion, metadata, and screenshot checks PASS
for desktop and mobile projects.

- [ ] **Step 5: Capture the supplied user viewport**

Start the production or development server, then capture `/` at 1905×781 with animations disabled
to `apps/website/e2e/screenshots/home-user-viewport.png`. Confirm:

- headline, description, actions, and command are fully visible;
- the run panel is visible;
- the fault-trace heading or top edge appears before the fold;
- no control or label overlaps;
- the page uses the full width without stretched line lengths.

- [ ] **Step 6: Inspect all screenshots**

Open desktop and mobile home and docs screenshots. Check text fit, line lengths, gradient restraint,
sticky header composition, docs readability, scenario action prominence, and absence of large dead
bands. Fix any issue, rerun the affected verification, and recapture.

- [ ] **Step 7: Update the QA record**

Rewrite `design-qa.md` with:

- source and reference screenshot paths;
- tested viewport dimensions;
- navigation changes;
- first-viewport measurements;
- accessibility and overflow results;
- screenshot paths;
- any residual visual risk.

- [ ] **Step 8: Commit verified visual artifacts**

```bash
git add apps/website/e2e/portal.spec.ts apps/website/e2e/screenshots design-qa.md
git commit -m "test(website): verify Cashu control room redesign"
```
