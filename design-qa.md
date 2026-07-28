# Cashu Fault Lab responsive design QA

final result: passed

## Evidence

- Source visual truth:
  `/var/folders/22/w1y7jxm926g_k50fq9wt1j5m0000gn/T/TemporaryItems/NSIRD_screencaptureui_3HCh76/Screenshot 2026-07-29 at 12.17.35 AM.png`
- Source pixels: 3840 × 2160 at macOS Retina density; the browser content is approximately a
  1920 CSS-pixel laptop viewport at 100% zoom.
- Same-browser implementation:
  `apps/website/e2e/screenshots/home-user-viewport.png`
- Implementation viewport capture: 1905 × 781 pixels, Chrome at 100% zoom.
- Responsive captures:
  `apps/website/e2e/screenshots/home-desktop.png` at 1440 CSS pixels and
  `apps/website/e2e/screenshots/home-mobile.png` plus
  `apps/website/e2e/screenshots/docs-mobile.png` at 390 CSS pixels.
- State: home page at initial load; documentation navigation collapsed on phone.

## Full-view comparison

The supplied screenshot showed an oversized hero: the headline consumed most of the laptop
viewport, the command and primary actions sat at the bottom edge, and the next section required a
large scroll before its content became useful. The revised same-browser capture keeps the complete
hero copy, both actions, command, and Cashu instrument visible together. The 1440 and 390 captures
preserve the same hierarchy without horizontal overflow.

## Focused-region comparison

- Typography: Archivo Black remains the display face, but the desktop headline is capped at
  6.35rem and the secondary headings at 3.5rem. Phone display type remains fluid and readable.
- Spacing and rhythm: desktop section padding now tops out at 5.5rem; the hero tops out at 45rem;
  the fault trace uses shorter cards and a tighter heading-to-timeline gap.
- Colors and tokens: the original purple and sand tokens are unchanged.
- Image quality: the supplied pixel-art Cashu asset remains pixelated and unstretched in the hero
  and is now also present in the header.
- Copy and content: canonical repository content remains unchanged and continues to drive the docs.

## Comparison history

1. P1: laptop hero and fault-trace sections were too large at 100% zoom.
   Fixed with bounded fluid type, shorter section padding, a lower hero height cap, and a smaller
   instrument. Post-fix evidence is the same-browser and 1440 desktop capture.
2. P1: mobile documentation placed the full documentation index before every article.
   Fixed with a collapsed, 48px-tall “Browse documentation” disclosure. Post-fix evidence is
   `docs-mobile.png`.
3. P1: CLI, Adapters, and GitHub header destinations were incorrect.
   Fixed and covered by unit/browser navigation checks.
4. P2: evidence exposed only aggregate invariant counts.
   Fixed with a responsive list of all 18 invariant IDs, statuses, confidence values, and reasons.

## Verification

- 11 Playwright checks passed at 1440 × 900 and 390 × 844; 5 desktop/mobile-specific cases were
  intentionally skipped in the opposite project.
- Every public route passed horizontal-overflow checks in both projects.
- Axe reported no serious or critical issues.
- Mobile menu, documentation disclosure, touch targets, search focus containment, and heading-anchor
  navigation were exercised.
