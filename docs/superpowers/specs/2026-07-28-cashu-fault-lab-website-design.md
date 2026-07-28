# Cashu Fault Lab developer portal

**Date:** 2026-07-28  
**Status:** Approved for implementation planning  
**Audience:** Cashu wallet, mint, protocol, and infrastructure developers

## 1. Purpose

Cashu Fault Lab needs a public developer portal that explains the delivery problem, makes the lab immediately runnable, and exposes the repository documentation through a navigable website.

The page's single job is to help a Cashu developer move from “why does this lab exist?” to “I can run or integrate it” without reading the repository tree first.

The website must not create a second documentation source. Repository Markdown remains canonical for GitHub and the deployed portal.

## 2. Goals

- Explain ambiguous Cashu delivery and the lab's recovery model in plain language.
- Put the deterministic demo command above the fold.
- Show real checked-in evidence rather than decorative product claims.
- Provide multi-page, searchable documentation.
- Make adapter integration and release status easy to find.
- Preserve direct links to source Markdown and GitHub editing.
- Use the supplied Cashu image and its purple/sand identity.
- Work cleanly on desktop, tablet, and mobile.
- Build locally and deploy to a newly created Vercel project.
- Rebuild automatically from the same Markdown developers edit on GitHub.

## 3. Non-goals

- Hosting an interactive mint, wallet, or funded scenario runner.
- Turning the developer preview into a certification claim.
- Editing documentation through the website.
- Replacing GitHub issues, discussions, or pull requests.
- Rewriting protocol documents as website-only MDX.
- Introducing a third brand hue or copying PSBT Interop Lab's dark/orange visual identity.

## 4. Reference-site findings

PSBT Interop Lab provides useful structural patterns:

- a problem-first hero;
- an immediately runnable command;
- a concrete compatibility report;
- navigation organized around docs, matrix, adapters, and security;
- a searchable documentation surface;
- visible source links;
- strong mobile restructuring.

Cashu Fault Lab will borrow those information-design ideas, not its layout or visual identity. The distinctive Cashu element will be a fault-and-recovery timeline that demonstrates one logical delivery converging after response loss.

## 5. Information architecture

### 5.1 Global navigation

- Home
- Docs
- CLI
- Scenarios
- Adapters
- Architecture
- Release status
- GitHub

Desktop uses a compact top navigation with a search trigger. Mobile uses a header with search and a navigation drawer. GitHub remains an external destination.

### 5.2 Home

The home page is a guided technical narrative:

1. **Hero:** the problem, deterministic demo command, GitHub action, and developer-preview label.
2. **Fault timeline:** reserve proofs → send → lose response → exact retry → recover → one durable credit.
3. **Evidence report:** render the checked-in v0.1 demo artifact as an understandable report.
4. **What gets tested:** retries, duplicates, transport loss, process crashes, recovery, and cross-language adapters.
5. **How delivery-v1 works:** durable sender, receiver, mint recovery, and independent oracle.
6. **Invariant coverage:** all 18 invariant names and current evidence state.
7. **Adapters:** cashu-ts, CDK, reference components, and adapter scaffold entry points.
8. **Security boundary:** local/test-only control surfaces, redaction, and fail-closed evidence.
9. **Release status:** developer preview, passing test evidence, and strict-gate gaps.
10. **Contribute:** adapter integration, technical review, and GitHub links.

### 5.3 Documentation

The documentation portal uses a left navigation, central article, and right-hand table of contents on large screens. Tablet removes the right rail. Mobile moves navigation into a drawer and renders the table of contents inline.

Initial routes:

| Route                     | Canonical source                    |
| ------------------------- | ----------------------------------- |
| `/docs/getting-started`   | `README.md`                         |
| `/docs/cli`               | `docs/cli-reference.md`             |
| `/docs/adapters`          | `docs/adapter-guide.md`             |
| `/docs/delivery-profile`  | `spec/delivery-v1.md`               |
| `/docs/invariants`        | `spec/invariants.md`                |
| `/docs/threat-model`      | `spec/threat-model.md`              |
| `/docs/release-notes`     | `docs/releases/v0.1.0.md`           |
| `/docs/release-checklist` | `docs/releases/v0.1.0-checklist.md` |

Each article shows:

- generated heading anchors;
- syntax-highlighted code;
- copy buttons on code blocks;
- previous/next document navigation;
- “View source” and “Edit on GitHub” links;
- a generated on-page table of contents;
- source-file metadata.

### 5.4 Scenarios

The scenarios index is generated from `scenarios/**/*.json`. It groups scenarios by family, shows the fault boundary and expected behavior, and links to the source JSON. It does not duplicate scenario definitions.

### 5.5 Architecture

The architecture page explains:

- sender reservation and retry state;
- HTTP and Nostr fault services;
- receiver transaction and recovery state;
- mint recovery evidence;
- independent oracle evaluation;
- report and release-policy outputs.

The page uses a Cashu-specific delivery flow, not a generic repository dependency diagram.

### 5.6 Release status

The release page renders developer-preview status and checked-in policy requirements without suggesting certification. It must state that strict qualification currently requires two qualifying implementation pairs, two distinct mint identities, independent evidence authorities, and external integrations.

## 6. Single-source content architecture

### 6.1 Canonical content

`README.md`, `docs/**/*.md`, selected `spec/*.md`, `scenarios/**/*.json`, and the checked-in demo artifact remain canonical. Website components may add framing, navigation, and visualization, but may not restate full documents in website-owned files.

### 6.2 Content registry

A typed `content-registry.ts` maps source paths to:

- public route;
- navigation group and order;
- display title override when necessary;
- short description;
- GitHub source URL.

The registry contains metadata only. It never contains article bodies.

### 6.3 Build-time processing

The website reads repository content during `next build`:

1. Resolve the repository root from the website package.
2. Validate every registered source path.
3. Read and parse Markdown.
4. Generate heading IDs, table-of-contents data, code highlighting, and search records.
5. Generate static pages.
6. Fail the build for a missing registered file, duplicate route, duplicate heading ID, invalid scenario JSON, or broken internal source mapping.

Documentation changes therefore update GitHub and the website with one commit and one deployment.

### 6.4 Search

Search is generated at build time from titles, descriptions, headings, and normalized article text. It runs client-side and does not require an external search service. Results link to exact heading anchors.

## 7. Technical architecture

### 7.1 Application

- `apps/website`
- Next.js with the App Router
- TypeScript
- Static generation for content and marketing routes
- React only where interactivity is required
- CSS Modules for components plus one global token/reset stylesheet; no general-purpose component theme

The package joins the existing pnpm/Turbo workspace and uses Node 24 and pnpm 11 already required by the repository.

### 7.2 Key modules

- `lib/content`: source resolution, Markdown parsing, table of contents, and search records.
- `lib/scenarios`: scenario discovery and safe metadata extraction.
- `components/docs`: document shell, source actions, navigation, code blocks, and search.
- `components/home`: fault timeline, evidence report, coverage, adapters, and release status.
- `app`: statically generated routes and metadata.

Each module has one responsibility and receives typed data rather than reading unrelated files directly.

### 7.3 Data boundaries

Build-time content readers are server-only. Browser bundles receive rendered article output and the minimal search index. Raw proof secrets, runtime artifacts, environment files, and ignored `artifacts/` content must never be included.

Only the checked-in, reviewed demo JSON may be used for the public evidence visualization.

## 8. Visual system

### 8.1 Brand colors

The two sampled anchors are:

- Cashu purple: `#7F38CA`
- Cashu sand: `#DCC099`

The site uses only purple and sand hue families. The initial accessible scale is:

- purple 950: `#2B0C4A`
- purple 700: `#5B2099`
- purple 500 anchor: `#7F38CA`
- sand 500 anchor: `#DCC099`
- sand 300: `#E9D4AE`
- sand 100: `#F6EBD6`

There is no third accent hue. Pass, warning, failure, and unknown states use icon shape, pattern, label, and weight instead of green/red semantics.

### 8.2 Typography

- **Display:** Archivo Black for major headlines and compact section statements.
- **Body:** IBM Plex Sans Variable for navigation and long documentation.
- **Utility/code:** IBM Plex Mono for commands, evidence IDs, scenario names, and status metadata.

Font files are installed through Fontsource packages and bundled with the website so rendering does not depend on a build-time or runtime third-party font request.

### 8.3 Layout

The site alternates purple and sand surfaces rather than using generic card grids. Borders, dividers, and labels describe protocol boundaries and evidence state.

The signature hero uses an asymmetric layout:

```text
┌──────────────────────────────────────────────────────────────┐
│ navigation                                      search GitHub │
├──────────────────────────────┬───────────────────────────────┤
│ Make Cashu delivery          │ reserve → send → response ×   │
│ fail safely.                 │               ↓               │
│ supporting copy              │ exact retry → recovered → 1x  │
│ [Run demo] [GitHub]          │                               │
│ $ pnpm lab demo              │ animated delivery trace       │
└──────────────────────────────┴───────────────────────────────┘
```

On mobile, copy, actions, command, and timeline stack in that order.

### 8.4 Motion

One orchestrated hero animation moves a proof packet through the delivery states, loses the response, retries with the same identifier, and converges on one credit. Motion is functional and pauses after convergence.

All animation respects `prefers-reduced-motion`; reduced mode shows the completed timeline with no movement.

### 8.5 Supplied Cashu image

The pixel Cashu image appears as the header mark, favicon source, and a restrained empty/search state illustration. It is not repeated as decoration throughout the page.

## 9. Content voice

Copy is direct and technical:

- Hero: “Make Cashu delivery fail safely.”
- Supporting line: “Inject response loss, retries, duplicates, and process crashes across real wallets and mints—then prove every implementation converges.”
- Primary action: “Run the deterministic demo.”
- Secondary action: “View on GitHub.”

The site must distinguish:

- transport acceptance from durable delivery;
- developer evidence from strict release qualification;
- the experimental application profile from an accepted NUT;
- a reference component from an independent implementation.

## 10. Interaction and responsive behavior

- Search opens through the header control and `Cmd/Ctrl + K`.
- Search, navigation drawer, code-copy controls, and source links are keyboard accessible.
- The current document and current heading are visibly identified.
- Code blocks scroll horizontally without creating page-level overflow.
- Wide report tables transform into labeled records on narrow screens.
- The fault timeline becomes vertical below the tablet breakpoint.
- Focus is never indicated by color alone.
- Interactive controls have at least 44×44 CSS-pixel targets on touch layouts.

## 11. Accessibility

- Semantic landmarks and heading order.
- Skip-to-content link.
- Accessible names for icon controls.
- Contrast verified for every text and control pairing.
- No status communicated only through color.
- Reduced-motion support.
- Visible keyboard focus.
- Search dialog focus management and Escape behavior.
- Decorative pixel art ignored by assistive technology; meaningful images have concise alternatives.

## 12. SEO and metadata

- Descriptive titles and summaries for every route.
- Canonical URLs.
- Open Graph image derived from the Cashu mark and fault timeline.
- Sitemap and robots metadata.
- Structured software-application metadata for the project.
- GitHub repository, release notes, and source-file links.

No page may describe the current preview as certified or production-safe.

## 13. Error handling

- Missing or invalid canonical content fails the build.
- Unknown docs routes return a branded 404 with links to search and Getting Started.
- Search with no results suggests CLI, adapters, scenarios, and GitHub source.
- Unsupported Markdown constructs render as escaped text rather than executing arbitrary HTML.
- External links are marked and use safe new-tab attributes where appropriate.

## 14. Testing

### 14.1 Unit and content tests

- content registry uniqueness;
- source-path existence;
- heading extraction and stable slugs;
- source/edit URL generation;
- scenario grouping;
- search indexing;
- untrusted HTML handling;
- demo artifact parsing.

### 14.2 Rendering and interaction tests

- home and all registered docs routes render;
- keyboard search workflow;
- mobile navigation;
- code-copy feedback;
- missing page;
- reduced-motion timeline;
- no horizontal overflow at target viewports.

### 14.3 Quality gates

- TypeScript passes.
- Next production build passes.
- Existing repository checks remain unaffected.
- Accessibility smoke audit has no serious violations.
- Desktop and mobile screenshots are visually reviewed.
- All internal routes and registered GitHub source links are valid.

## 15. Deployment

`apps/website` is the Vercel project root. “Include files outside the root directory in the Build
Step” stays enabled so the website can read canonical repository content.

`apps/website/vercel.json` declares:

- the website build command;
- the Next.js output directory;
- the pnpm install command;
- the framework.

The deployment flow:

1. Install with the repository's pinned pnpm version.
2. Build `@cashu-fault-lab/website`.
3. Generate static docs, scenario, architecture, and status routes.
4. Create a new Vercel project.
5. Deploy a preview, because production was not explicitly requested.
6. Return the preview URL and claim URL when anonymous deployment is used.

No secrets or runtime environment variables are required for the initial portal.

## 16. Acceptance criteria

- A full multi-page portal is available locally and at a Vercel preview URL.
- Home communicates the problem, method, evidence, adapters, security boundary, and current release status.
- The deterministic demo command is visible above the fold.
- All registered repository Markdown renders as navigable documentation.
- One repository Markdown edit changes both GitHub content and the next website build.
- Search finds headings and content across registered docs.
- Scenarios are generated from repository JSON.
- Every document links to its canonical GitHub source and edit page.
- The supplied Cashu image is integrated.
- Purple and sand are the only hue families.
- Desktop and mobile layouts have no page-level horizontal overflow.
- Reduced-motion and keyboard workflows work.
- The website never claims certification.
- Production build and website tests pass before deployment.
