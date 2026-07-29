# Cashu Fault Lab responsive design QA

Final result: passed on 2026-07-29.

## Sources and captures

- Supplied visual source: the user-provided 100%-zoom laptop screenshot attached to the design task.
- Source dimensions: 3840 x 2160 Retina pixels, approximately a 1920 CSS-pixel browser
  viewport at 100% zoom.
- Exact laptop reference:
  `apps/website/e2e/screenshots/home-user-viewport.png` at 1905 x 781.
- Exact tablet reference:
  `apps/website/e2e/screenshots/home-tablet.png` at 768 x 1024.
- Desktop full-page references:
  `apps/website/e2e/screenshots/home-desktop.png` at 1440 x 6587 and
  `apps/website/e2e/screenshots/docs-desktop.png` at 1440 x 9003.
- Mobile full-page references:
  `apps/website/e2e/screenshots/home-mobile.png` at 390 x 10929 and
  `apps/website/e2e/screenshots/docs-mobile.png` at 390 x 13132.
- Architecture-in-Docs references:
  `apps/website/e2e/screenshots/architecture-desktop.png` at 1440 x 3024 and
  `apps/website/e2e/screenshots/architecture-mobile.png` at 390 x 4474.
- Additional viewport-only inspection captures covered home and docs at 1905 x 781, 1440 x 900,
  1024 x 768, 768 x 1024, and 390 x 844. Playwright used Chromium, a device scale factor of 1,
  reduced motion, and disabled screenshot animations.

## Navigation

The compact header now exposes Home, Docs, and Release status. It does not expose the removed
global Scenarios destination. The mobile browser contract opens the menu, checks all four
conditions, follows Docs, opens Browse documentation, and verifies 44px controls.

## First viewport measurements

- 1905 x 781: the 68px header occupies `y=0..68`; the hero occupies `y=68..765`; the trace
  section starts at `y=765`, leaving a 16px next-section cue. The headline ends at `446.92`,
  description at `528.89`, primary action at `604.08`, command at `676.06`, and run panel at
  `505.86`. The labeled "Next / deterministic fault trace" link occupies `y=710..754`, at least
  33.94px below the lowest required hero element and fully inside the viewport.
- 1440 x 900: the hero ends and trace starts at `y=788`. The trace eyebrow is visible in the
  first viewport; the trace heading starts at `y=909.58`.
- 1024 x 768: the 60px compact header fits its 44px brand and menu controls. The hero ends and
  trace starts at `y=744`, leaving a 24px next-section cue.
- 768 x 1024: the 60px compact header precedes a stacked hero at `x=20..748`, `y=60..880.84`.
  The heading ends at `302.48`, actions at `450.45`, command at `558.22`, and run panel at
  `797.94`; every required hero element and the next-section cue fit in the viewport.
- 390 x 844: the headline, description, actions, and command end by `y=831.19`. The run panel
  follows at `y=867.19`, below the first phone fold by design. No text or control overlaps.

## Readability and fit

- Document `scrollWidth` equals viewport width at 1905, 1440, 1024, 768, and 390 for both home and
  docs.
- At 768 x 1024 the command has `clientWidth=590` and `scrollWidth=590`; its metadata has
  `clientWidth=539` and `scrollWidth=539`; and the run panel has `clientWidth=665` and
  `scrollWidth=665`. Element-level assertions also keep the heading, actions, command, metadata,
  and panel inside the hero.
- The final visible-leaf text scan found no clipped text. The repaired phone security heading
  reports `scrollWidth=310` and `clientWidth=310`.
- Docs paragraph widths top out at 710.39px on wide desktop, 646.14px at 1024, and 320.81px on
  phone. Wide code scrolls inside its code block rather than widening the page.
- The docs phone H1 uses a fixed 44px responsive step at both 390px and 430px viewport widths.
- The mobile docs disclosure is 50px high. The inspection scan and Playwright touch-target checks
  found no visible target below 44 x 44.
- Architecture retains its generated visual topology at `/architecture` while using the same
  desktop sidebar, mobile disclosure, table of contents, current state, and pagination as Markdown
  documents. Generated heading search now returns section records; desktop and mobile Playwright
  query "Recovery behavior is not release evidence" and navigate directly to
  `/architecture#separation-title`. Its captures pass the same Axe and overflow checks.
- Gradients stay limited to the restrained hero treatment, primary action emphasis, and trace
  rail. Docs uses no gradients. Full-page inspection found no large empty bands or stretched
  reading lines.

## Verification

- Website unit tests: 11 files and 61 tests passed.
- Type generation and `tsc --noEmit`: passed.
- Production build: passed and generated 20 static or SSG routes.
- Playwright: 17 passed and 9 project-specific cases skipped across desktop and mobile projects.
- Axe scanned all 12 listed public routes in both projects, for 24 route/viewport scans. The final
  run found no serious or critical violations.
- Every public route passed horizontal-overflow checks in both projects.
- Reduced motion, canonical metadata, discovery endpoints, search focus containment, docs heading
  navigation, generated Architecture navigation/search/pagination, the empty-search recovery
  target, compact navigation, local code scrolling, touch targets, the exact 1905 x 781 trace cue,
  the 768 x 1024 hero clipping contract, and screenshot capture passed.

## Final review fixes

1. Made ordered documentation destinations the shared source for Markdown and generated pages,
   placing Architecture immediately after Adapter guide without duplicating navigation ordering.
2. Rendered `/architecture` inside the Docs shell with current navigation, search discovery, table
   of contents, pagination, sitemap discovery, and its existing generated topology intact.
3. Replaced the primary CTA's low-contrast endpoint, removed its `!important`, and standardized
   Warm sand focus rings on dark and plum surfaces with focused contrast checks.
4. Enlarged the mobile empty-search recovery link to a measured 44 x 44 minimum target.
5. Added a familiar search icon with a desktop label and mobile icon-only presentation while
   preserving the button's accessible name.
6. Added the labeled in-page trace cue and exact 1905 x 781 bounds assertion, plus permanent
   desktop/mobile Architecture integration coverage and captures.
7. Emitted section-level search records for generated Architecture headings and verified direct
   desktop/mobile navigation to the matching anchor.
8. Moved hero stacking and command wrapping to the 900px breakpoint, with permanent 768 x 1024
   clipping assertions and a reviewed tablet capture.

## Earlier responsive fixes retained

1. Updated the stale home-fold, manifest color, and compact-navigation E2E contracts.
2. Replaced the mobile docs `12vw` heading term with a fixed `2.75rem` responsive step.
3. Stacked the phone security marker above its copy so "implementation" no longer clips.
4. Reduced the low-height desktop hero minimum by 16px so the next section starts before the
   1905 x 781 fold.
5. Added permanent browser coverage for docs heading stability, phone security-heading fit, and
   the exact user viewport.
6. Extended Axe coverage from Home and Getting started to every listed public route in both
   projects. The first expanded run exposed unlabeled GFM task-list checkboxes on Release
   checklist; the shared Markdown renderer now gives checked and unchecked items accessible names.

## Residual risks

- The configured browser matrix covers Chromium only; WebKit and Firefox can still differ in font
  metrics and sticky positioning.
- Next reports the existing linked-worktree workspace-root/NFT trace warning during production
  builds. The build and Playwright server still exit successfully.
- The supplied source image lives in a macOS temporary directory and may be purged. The committed
  1905 x 781 reference is the durable comparison artifact.
