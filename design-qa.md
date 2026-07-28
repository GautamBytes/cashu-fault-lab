# Cashu Fault Lab responsive design QA

Final result: passed on 2026-07-29.

## Sources and captures

- Supplied visual source recorded by the prior QA pass:
  `/var/folders/22/w1y7jxm926g_k50fq9wt1j5m0000gn/T/TemporaryItems/NSIRD_screencaptureui_3HCh76/Screenshot 2026-07-29 at 12.17.35 AM.png`
- Source dimensions: 3840 x 2160 Retina pixels, approximately a 1920 CSS-pixel browser
  viewport at 100% zoom.
- Exact laptop reference:
  `apps/website/e2e/screenshots/home-user-viewport.png` at 1905 x 781.
- Desktop full-page references:
  `apps/website/e2e/screenshots/home-desktop.png` at 1440 x 6587 and
  `apps/website/e2e/screenshots/docs-desktop.png` at 1440 x 9003.
- Mobile full-page references:
  `apps/website/e2e/screenshots/home-mobile.png` at 390 x 10929 and
  `apps/website/e2e/screenshots/docs-mobile.png` at 390 x 13132.
- Additional viewport-only inspection captures covered home and docs at 1905 x 781, 1440 x 900,
  1024 x 768, and 390 x 844. Playwright used Chromium, a device scale factor of 1, reduced motion,
  and disabled screenshot animations.

## Navigation

The compact header now exposes Home, Docs, and Release status. It does not expose the removed
global Scenarios destination. The mobile browser contract opens the menu, checks all four
conditions, follows Docs, opens Browse documentation, and verifies 44px controls.

## First viewport measurements

- 1905 x 781: the 68px header occupies `y=0..68`; the hero occupies `y=68..765`; the trace
  section starts at `y=765`, leaving a 16px next-section cue. The headline ends at `446.92`,
  description at `528.89`, actions at `604.08`, command at `676.06`, and run panel at `505.86`.
- 1440 x 900: the hero ends and trace starts at `y=788`. The trace eyebrow is visible in the
  first viewport; the trace heading starts at `y=909.58`.
- 1024 x 768: the 60px compact header fits its 44px brand and menu controls. The hero ends and
  trace starts at `y=744`, leaving a 24px next-section cue.
- 390 x 844: the headline, description, actions, and command end by `y=831.19`. The run panel
  follows at `y=867.19`, below the first phone fold by design. No text or control overlaps.

## Readability and fit

- Document `scrollWidth` equals viewport width at 1905, 1440, 1024, and 390 for both home and
  docs.
- The final visible-leaf text scan found no clipped text. The repaired phone security heading
  reports `scrollWidth=310` and `clientWidth=310`.
- Docs paragraph widths top out at 710.39px on wide desktop, 646.14px at 1024, and 320.81px on
  phone. Wide code scrolls inside its code block rather than widening the page.
- The docs phone H1 uses a fixed 44px responsive step at both 390px and 430px viewport widths.
- The mobile docs disclosure is 50px high. The inspection scan and Playwright touch-target checks
  found no visible target below 44 x 44.
- Gradients stay limited to the restrained hero treatment, primary action emphasis, and trace
  rail. Docs uses no gradients. Full-page inspection found no large empty bands or stretched
  reading lines.

## Verification

- Website unit tests: 10 files and 52 tests passed.
- Type generation and `tsc --noEmit`: passed.
- Production build: passed and generated 20 static or SSG routes.
- Playwright: 13 passed and 7 project-specific cases skipped across desktop and mobile projects.
- Axe found no serious or critical violations on the tested home and docs routes.
- Every public route passed horizontal-overflow checks in both projects.
- Reduced motion, canonical metadata, discovery endpoints, search focus containment, docs heading
  navigation, compact navigation, local code scrolling, touch targets, and screenshot capture
  passed.

## Fixes from this pass

1. Updated the stale home-fold, manifest color, and compact-navigation E2E contracts.
2. Replaced the mobile docs `12vw` heading term with a fixed `2.75rem` responsive step.
3. Stacked the phone security marker above its copy so "implementation" no longer clips.
4. Reduced the low-height desktop hero minimum by 16px so the next section starts before the
   1905 x 781 fold.
5. Added permanent browser coverage for docs heading stability, phone security-heading fit, and
   the exact user viewport.

## Residual risks

- The configured browser matrix covers Chromium only; WebKit and Firefox can still differ in font
  metrics and sticky positioning.
- Next reports the existing linked-worktree workspace-root/NFT trace warning during production
  builds. The build and Playwright server still exit successfully.
- The supplied source image lives in a macOS temporary directory and may be purged. The committed
  1905 x 781 reference is the durable comparison artifact.
