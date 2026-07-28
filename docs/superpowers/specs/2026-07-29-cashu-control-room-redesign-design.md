# Cashu Control Room portal redesign

**Date:** 2026-07-29
**Status:** Approved for implementation planning
**Audience:** Cashu wallet, mint, protocol, and infrastructure developers

## 1. Purpose

Cashu Fault Lab needs a denser, modern interface that reads as a working developer tool at 100%
browser zoom. The redesign applies one visual and interaction system to the home page,
documentation, scenario index, architecture content, release status, search, and error states.

The portal keeps Cashu's purple and sand identity. It shifts the dominant surface from pale sand to
near-black and deep plum, then uses Cashu violet and warm sand for hierarchy, status, and focus.

## 2. Success criteria

- The first viewport communicates the product, shows the primary command, exposes GitHub, and
  reveals the start of the fault trace on common laptop displays.
- Desktop content uses the available width without looking stretched or zoomed out.
- Section spacing supports scanning and removes large inactive bands.
- Every route shares the same dark developer-tool visual language.
- Documentation remains comfortable to read for long sessions.
- Navigation contains only Home, Docs, and Release status as primary destinations.
- CLI and Architecture move into documentation navigation.
- Scenarios leave the global navigation and receive a prominent home-page section and action.
- GitHub leaves the global navigation and remains available in the hero and source-level actions.
- Existing content, canonical Markdown sources, accessibility behavior, and release disclaimers
  remain intact.

## 3. Information architecture

### 3.1 Global header

Desktop navigation contains:

- Home
- Docs
- Release status
- Search

The Cashu Fault Lab brand mark links to Home. The header contains no CLI, Scenarios, Adapters,
Architecture, or GitHub item.

Mobile uses the same destination set inside the existing navigation drawer. Search remains a
dedicated control.

### 3.2 Documentation navigation

The documentation index contains:

1. Getting Started
2. CLI
3. Adapters
4. Architecture
5. Delivery Profile
6. Invariants
7. Threat Model
8. Release Notes
9. Release Checklist

Architecture remains available at its existing public route when required for compatibility, but
the user reaches it through Docs. The docs index and search both include it.

### 3.3 Scenario discovery

The home page includes an “Explore fault scenarios” section after the deterministic trace and
evidence preview. It summarizes the scenario families and links to the generated scenario index.

The section shows four representative families:

- response loss and retry;
- crash recovery;
- duplicate and concurrency;
- security and malformed transport behavior.

A compact scenario count and direct action make the route discoverable without adding it back to
the global header.

### 3.4 GitHub discovery

The hero keeps “View on GitHub” as its secondary action. Documentation pages keep “View source” and
“Edit on GitHub.” Scenario records keep source JSON links. No global GitHub navigation item remains.

## 4. Visual direction

### 4.1 Concept

The visual concept is **Cashu Control Room**: a precise fault-injection console with visible
protocol traces, evidence readouts, and command surfaces. The interface borrows the second
reference site's depth and gradient energy without copying its orange palette, centered hero, or
dot pattern.

The home page uses one signature visual: a responsive fault-field behind the hero. A violet packet
trace crosses a restrained pixel matrix, hits a response-loss boundary, retries, and converges.
The existing Cashu pixel mark appears inside the trace as a small brand instrument rather than a
large tilted poster.

### 4.2 Color tokens

- Ink: `#09070D`
- Control surface: `#121018`
- Elevated surface: `#1A1422`
- Deep plum: `#2B0C4A`
- Cashu violet: `#7F38CA`
- Electric violet: `#A855F7`
- Warm sand: `#DCC099`
- Light sand: `#F6EBD6`
- Muted text: `#A99CAE`
- Hairline: `rgba(220, 192, 153, 0.16)`

Gradients combine Ink, Deep plum, Cashu violet, and Electric violet. Sand remains a text and
signal color, not the main page background. Statuses continue to use labels, symbols, borders, and
patterns so color never carries meaning alone.

### 4.3 Typography

- Display: Archivo Black for the product statement and major section headings.
- Body: IBM Plex Sans Variable for navigation, explanations, and documentation.
- Utility: IBM Plex Mono for commands, evidence IDs, counts, timestamps, and status labels.

The hero headline targets `clamp(3.4rem, 6.2vw, 6.8rem)` with a compact line height. Section
headings target `clamp(2rem, 3.6vw, 3.75rem)`. Body text remains between 1rem and 1.2rem. Type does
not scale directly from viewport width outside bounded `clamp()` values.

### 4.4 Layout density

The portal increases its content container from the current narrow reading frame to a
`min(100% - 2rem, 1560px)` shell for the home and application surfaces. Documentation keeps a
narrow article measure inside a wider three-column shell.

Desktop home sections use 64 to 96 pixels of vertical padding. Compact technical bands use 40 to
64 pixels. The hero uses `min-height: calc(100svh - header)` with internal bounds that keep all
controls visible and leave 48 to 96 pixels of the next section in view.

Cards remain limited to evidence records, scenario records, repeated status items, and framed
tools. Page sections use full-width bands and grid lines rather than floating containers.

## 5. Home page

### 5.1 Hero

The hero uses a two-column layout.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Cashu Fault Lab            Home  Docs  Release status     Search    │
├──────────────────────────────────────┬───────────────────────────────┤
│ CASHU DELIVERY FAULT LAB             │ live fault run                │
│ Make Cashu delivery                  │ prepared  → sent              │
│ fail safely.                         │ response × → exact retry      │
│                                      │ recovered → converged         │
│ concise supporting copy              │                               │
│ [Run demo] [View on GitHub]          │ scenario / seed / evidence    │
│ $ pnpm lab demo            [copy]    │                               │
├──────────────────────────────────────┴───────────────────────────────┤
│ deterministic fault trace begins                                  ↓ │
└──────────────────────────────────────────────────────────────────────┘
```

The left column owns the product statement and commands. The right column renders a compact live
run panel from existing deterministic demo data. The supplied Cashu mark appears as a small
instrument icon inside the panel.

The hero background uses CSS gradients and a lightweight pixel/grid mask. It must stay readable
without animation. Reduced-motion mode shows the converged state.

### 5.2 Deterministic trace

The existing six-stage fault trace follows the hero without a large vertical break. On desktop it
uses one horizontal rail with compact stages. On mobile it becomes a vertical sequence. Its
surface stays dark and uses brighter violet at the active failure and recovery boundaries.

### 5.3 Evidence

The evidence summary becomes a control-room report:

- the report explanation and scenario metadata share one top row;
- primary counts appear in a compact strip;
- invariant evidence uses a readable responsive table or record list;
- source actions sit in a single footer bar.

The layout removes the current large empty left column beside the long invariant list.

### 5.4 Scenario promotion

The scenario section follows evidence. A short heading, family filters or family summaries, current
scenario count, and “Explore all scenarios” action replace the removed navbar destination.

### 5.5 Remaining sections

The profile, invariant coverage, adapters, security boundary, release status, and contribution
content remain. The redesign groups them into tighter full-width bands:

- profile and invariant coverage share a connected protocol/evidence band;
- adapters and security use a two-column technical boundary layout;
- release status uses a compact warning strip with exact policy numbers;
- contribution closes the page with a single command-oriented action row.

## 6. Documentation and content pages

### 6.1 Docs shell

Large screens use:

```text
┌───────────────┬──────────────────────────────────┬─────────────────┐
│ docs index    │ article                          │ on this page    │
│               │                                  │                 │
│ CLI           │ title, source metadata           │ active heading  │
│ Architecture  │ readable 70–78ch measure         │ heading links   │
│ ...           │ code and technical tables        │                 │
└───────────────┴──────────────────────────────────┴─────────────────┘
```

The sidebars use dark control surfaces. The article uses a subtly lifted near-black surface rather
than a white or sand card. Thin purple and sand hairlines define hierarchy.

Tablet removes the right rail. Mobile keeps the existing documentation disclosure and puts the
table of contents inline.

### 6.2 Code and data

Code blocks use a Cashu-aware dark syntax theme, a visible language label, and an icon copy control.
Tables preserve headers while allowing contained horizontal scrolling. Heading anchors and focus
styles remain visible.

### 6.3 Scenario, architecture, and release routes

Scenario records use the shared dark technical surfaces and tighter filters. Architecture adopts
the same docs shell and appears in the docs navigation. Release status uses compact policy
readouts, evidence counts, and explicit developer-preview language.

## 7. Header, search, and controls

- The sticky header is 64 to 72 pixels tall on desktop and 56 to 64 pixels on mobile.
- The header uses a translucent Ink surface with a solid fallback and a bottom hairline.
- Search appears as an icon-plus-label control on desktop and an icon control on mobile.
- Buttons use a maximum 6-pixel radius.
- Primary actions use a violet gradient with sand or white text.
- Secondary actions use transparent surfaces with hairline borders.
- Familiar controls use Lucide icons where the current dependency set supports them. Existing
  text symbols remain only when they encode protocol state.
- Hover changes border, background, or elevation without moving layout.
- Keyboard focus uses a sand ring with sufficient contrast.

## 8. Motion

The page uses one orchestrated sequence in the hero and fault trace:

1. Prepare one delivery identity.
2. Move the packet to the receiver.
3. Mark the response boundary as lost.
4. Send the exact retry.
5. Resolve evidence.
6. Hold on the converged state.

The animation runs once on initial entry or loops with a long pause. UI controls use transitions
under 180 milliseconds. `prefers-reduced-motion: reduce` disables travel and reveal animation.

## 9. Responsive behavior

- At 1440×900 and similar laptop sizes, the hero fills the screen below the header and exposes the
  next technical band.
- At wide desktop sizes, content grows to the wider shell instead of remaining centered in a narrow
  column.
- At 768 to 1024 pixels, the hero keeps two balanced columns when content fits and stacks before
  either column becomes cramped.
- At 390 pixels, actions become full-width, command metadata wraps or hides, navigation remains
  compact, and no section causes page-level horizontal overflow.
- Fixed-format elements use stable grid tracks and aspect ratios so state changes do not shift the
  layout.

## 10. Accessibility

- Preserve semantic landmarks, heading order, skip links, and accessible names.
- Keep keyboard search, mobile navigation, documentation disclosure, and code copy workflows.
- Maintain 44-pixel touch targets on mobile.
- Use text and symbols with color for each state.
- Test all new color pairings for WCAG AA contrast.
- Keep the supplied pixel mark's existing meaningful alternative text where it communicates the
  project mark.
- Disable nonessential movement for reduced-motion users.

## 11. Technical scope

The redesign changes presentation and navigation composition inside `apps/website`. It reuses the
existing Next.js App Router, content registry, static generation, demo parsing, release-status
logic, search behavior, and canonical repository content.

Likely implementation areas:

- `app/globals.css`
- `components/site-header.tsx`
- `components/site-header.module.css`
- `components/portal-shell.tsx`
- `components/home/*`
- `components/docs/*`
- shared content-page styles
- focused unit and Playwright expectations for navigation and layout

The work does not change protocol behavior, scenario definitions, evidence computation, release
policy rules, or canonical documentation bodies.

## 12. Verification

Implementation must pass:

- website unit tests;
- TypeScript checks;
- the production Next.js build;
- existing Playwright navigation and accessibility checks;
- horizontal-overflow checks on every public route at desktop and mobile widths;
- visual review at 1905×781, 1440×900, 1024×768, and 390×844;
- reduced-motion verification;
- first-viewport checks for hero content and next-section visibility.

The visual review compares the supplied current-state and reference screenshots against fresh local
captures. It checks density, content scale, gradient restraint, documentation readability, text
fit, and control overlap.

## 13. Acceptance criteria

- The full portal uses the Cashu Control Room system.
- The global header contains Home, Docs, Release status, and Search.
- CLI and Architecture appear inside documentation navigation.
- Scenarios receive a prominent home section and leave the global header.
- GitHub leaves the global header and remains in the hero and source actions.
- The home page uses the full desktop viewport at 100% zoom without oversized dead space.
- The first viewport shows the primary command and a hint of the fault trace.
- All content pages remain readable and responsive.
- Purple gradients support hierarchy without dominating every surface.
- No public route has page-level horizontal overflow.
- Search, drawers, disclosures, code copy, and keyboard navigation still work.
- The build and automated website checks pass.
