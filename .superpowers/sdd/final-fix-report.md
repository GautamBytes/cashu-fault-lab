# Final review fix report

- Date: 2026-07-29
- Worktree: `/Users/gautammanch/Developer/cashu-fault-lab/.worktrees/release-gate-integrity`
- Branch: `codex/release-gate-integrity`
- Status: Complete and verified

## Inherited patch note

This task resumed an interrupted final-review wave. The worktree already contained an uncommitted
patch across 21 website files. I preserved that work, inspected the complete diff and existing test
coverage, and repaired the partial portions in place.

No RED output from the previous agent was available, so I do not claim a RED phase for the inherited
changes. The inherited focused regression set initially passed 39 tests across five files. During
the finishing pass I added two missing regression assertions for source-driven documentation group
ordering and the labeled trace destination, observed both fail for the expected reasons, then
implemented the fixes and observed 14/14 tests pass in those two files. An early Playwright attempt
failed before test execution because the sandbox denied the local server bind (`EPERM`); that is
recorded as an environment failure, not behavioral RED evidence.

## Implementation

### Architecture documentation integration

- Replaced the Markdown-only registry as the ordering authority with
  `DOCUMENTATION_DESTINATIONS`, a discriminated union that supports Markdown and generated pages.
- Registered generated Architecture immediately after Adapter guide while preserving
  `/architecture`, its generated topology, metadata, headings, and content.
- Derived Docs navigation group order from the ordered destination input instead of maintaining a
  second hard-coded group order.
- Made current state, previous/next links, search records, and sitemap entries consume destination
  `href` values, so generated and Markdown pages use the same path.
- Rendered Architecture through `DocsShell`, including desktop/mobile navigation, table of
  contents, `aria-current="page"`, and pagination.

### Contrast, focus, and CTA specificity

- Changed the primary CTA gradient to `--purple-700` through `--purple-500`; Light sand is at least
  4.5:1 against both declared stops.
- Removed the CTA text-color `!important` and corrected the inherited home-link selector so normal
  cascade specificity supplies the intended color.
- Standardized dark/plum focus outlines on Warm sand and added focused contrast assertions.

### Search and mobile targets

- Added a familiar search icon with a visible desktop label and shortcut hint.
- Kept `aria-label="Search documentation"` and switched to icon-only presentation in the compact
  header without adding a dependency.
- Enlarged the empty-search "Browse scenarios" recovery link to a 44px minimum target in both axes.
- Added a mobile Playwright measurement for the zero-result recovery link.

### Exact laptop trace cue

- Added a real in-page "Next / deterministic fault trace" link in the home hero and a stable
  `#fault-trace` destination.
- At 1905 x 781 the cue occupies `y=710..754`; the lowest required hero element ends at `y=676.06`,
  and the trace section begins at `y=765`.
- The exact-viewport browser test asserts the cue is visible, labeled, separated by at least 12px
  from required hero content, and fully inside the viewport.

### QA evidence

- Added desktop and mobile Architecture integration coverage for navigation, current state,
  pagination, generated search discovery, Axe, and overflow.
- Refreshed affected home and Docs screenshots and added dedicated Architecture desktop/mobile
  captures.
- Updated `design-qa.md` with the new composition, measurements, screenshots, and final counts.

## Verification

All commands used Node 24.14.1 with:

```text
PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH CI=true
```

| Gate | Result |
| --- | --- |
| Focused website tests | 5 files, 40 tests passed |
| Full website unit suite | 11 files, 60 tests passed |
| Website typecheck | `next typegen` and `tsc --noEmit` passed |
| Production build | Passed; 20 static/SSG routes generated |
| Full Playwright matrix | 16 passed, 8 intentional project-specific skips |
| Route-wide Axe/overflow | 12 public routes in desktop and mobile; 24 scans passed |
| Exact 1905 x 781 | Labeled cue, complete hero, reduced motion, and overflow checks passed |
| Empty mobile search | Zero-result recovery target measured at least 44 x 44 |
| Architecture integration | Desktop/mobile nav, current state, search, pagination, Axe, and overflow passed |
| Formatting | All touched text files passed Prettier check |
| Patch integrity | `git diff --check` passed |

The production build and Playwright web server emit the existing linked-worktree workspace-root/NFT
trace warning. Compilation, static generation, server startup, and all browser tests still complete
successfully.

## Files

Content model and loading:

- `apps/website/lib/content-types.ts`
- `apps/website/lib/content-registry.ts`
- `apps/website/lib/markdown.ts`
- `apps/website/lib/content.test.ts`

Routes and shared Docs shell:

- `apps/website/app/architecture/page.tsx`
- `apps/website/app/docs/[slug]/page.tsx`
- `apps/website/app/sitemap.ts`
- `apps/website/components/docs/docs-shell.tsx`
- `apps/website/components/docs/docs.module.css`
- `apps/website/app/content-pages.test.tsx`

Contrast, focus, header, search, and home cue:

- `apps/website/app/content-pages.module.css`
- `apps/website/app/globals.css`
- `apps/website/app/not-found.module.css`
- `apps/website/app/page.tsx`
- `apps/website/components/home/fault-timeline.tsx`
- `apps/website/components/home/home.module.css`
- `apps/website/components/home/home.test.tsx`
- `apps/website/components/search/search-dialog.test.tsx`
- `apps/website/components/search/search.module.css`
- `apps/website/components/site-header.module.css`
- `apps/website/components/site-header.tsx`
- `apps/website/test/shell.test.tsx`

Browser coverage and QA:

- `apps/website/e2e/portal.spec.ts`
- `apps/website/e2e/screenshots/home-desktop.png`
- `apps/website/e2e/screenshots/home-mobile.png`
- `apps/website/e2e/screenshots/home-user-viewport.png`
- `apps/website/e2e/screenshots/docs-desktop.png`
- `apps/website/e2e/screenshots/architecture-desktop.png`
- `apps/website/e2e/screenshots/architecture-mobile.png`
- `design-qa.md`

## Screenshots

- `apps/website/e2e/screenshots/home-user-viewport.png` - 1905 x 781 exact laptop viewport
- `apps/website/e2e/screenshots/home-desktop.png` - 1440 x 6587
- `apps/website/e2e/screenshots/home-mobile.png` - 390 x 10929
- `apps/website/e2e/screenshots/docs-desktop.png` - 1440 x 9003
- `apps/website/e2e/screenshots/docs-mobile.png` - 390 x 13132, unchanged by the final render
- `apps/website/e2e/screenshots/architecture-desktop.png` - 1440 x 3024
- `apps/website/e2e/screenshots/architecture-mobile.png` - 390 x 4474

I visually inspected the exact laptop, home mobile, and both Architecture captures. Text, controls,
generated topology, navigation, table of contents, and pagination are coherent with no visible
overlap or clipping.

## Self-review

- The destination registry is the sole page-order authority; the Docs shell no longer duplicates
  destination or group ordering.
- `/architecture` remains a generated route and does not masquerade as a Markdown source page.
- Markdown source/edit controls remain exclusive to Markdown documents.
- Architecture is discoverable from Docs navigation, search, pagination, and sitemap with the same
  canonical href.
- No CTA color `!important` remains and no dependency was added for the header search treatment.
- Unit tests validate CTA and focus contrast from the real design tokens; browser tests validate
  actual target dimensions and viewport composition.
- The final diff is limited to the review findings, supporting tests, screenshots, QA evidence, and
  this report.

## Concerns

- Browser coverage is Chromium-only; Firefox and WebKit can still differ in font metrics and sticky
  positioning.
- The existing Next.js linked-worktree workspace-root/NFT trace warning remains.
- The original supplied comparison image is in a macOS temporary directory and may be purged; the
  repository screenshots are the durable evidence.
- No unresolved functional or accessibility concerns were found in this fix wave.
