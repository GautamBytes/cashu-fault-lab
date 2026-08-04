# Evidence Image Lightbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let visitors open either v0.2.0 evidence screenshot at full resolution and close it with ×, backdrop click, or Escape.

**Architecture:** Extract the static evidence gallery into a focused React client component backed by a native `<dialog>`. The component owns selected-image state, dialog lifecycle, and focus restoration; `EvidenceReport` continues to own evidence data and page composition.

**Tech Stack:** React 19, Next.js 16 `Image`, TypeScript, CSS Modules, Vitest, Testing Library, Playwright.

## Global Constraints

- Add no third-party lightbox dependency.
- Keep both checked-in evidence images and their existing descriptive alternative text.
- Preserve the existing two-column desktop and single-column narrow gallery layout.
- Close through a visible 44-by-44-pixel control, backdrop click, and Escape.
- Restore focus to the screenshot button that opened the dialog.
- Do not change evidence claims, retained artifacts, provenance, or release links.

---

### Task 1: Accessible evidence gallery dialog

**Files:**

- Create: `apps/website/components/home/evidence-gallery.tsx`
- Create: `apps/website/components/home/evidence-gallery.test.tsx`

**Interfaces:**

- Consumes: the two static files `/evidence/v0.2.0-terminal.png` and `/evidence/v0.2.0-report.png`.
- Produces: `EvidenceGallery(): React.JSX.Element`, rendering both inline figures and one native image-preview dialog.

- [ ] **Step 1: Write failing component tests**

Create `evidence-gallery.test.tsx` with a dialog polyfill and behavior assertions:

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidenceGallery } from './evidence-gallery';

beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () {
    this.setAttribute('open', '');
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
});

describe('EvidenceGallery', () => {
  it('opens either screenshot in a full-resolution dialog', async () => {
    const user = userEvent.setup();
    render(<EvidenceGallery />);
    const trigger = screen.getByRole('button', {
      name: 'Enlarge terminal verification screenshot',
    });

    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Terminal verification output' });
    expect(dialog).toBeVisible();
    expect(
      within(dialog).getByRole('img', { name: /terminal showing the public doctor/i }),
    ).toHaveAttribute('src', '/evidence/v0.2.0-terminal.png');
  });

  it('closes through the close control, backdrop, and Escape while restoring focus', async () => {
    const user = userEvent.setup();
    render(<EvidenceGallery />);
    const trigger = screen.getByRole('button', {
      name: 'Enlarge generated evidence report screenshot',
    });

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Close image preview' }));
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(trigger).toHaveFocus();
  });

  it('does not close when the image panel is clicked', async () => {
    const user = userEvent.setup();
    render(<EvidenceGallery />);
    await user.click(
      screen.getByRole('button', { name: 'Enlarge terminal verification screenshot' }),
    );
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByTestId('evidence-dialog-panel'));

    expect(dialog).toHaveAttribute('open');
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing component fails**

Run: `pnpm --filter @cashu-fault-lab/website exec vitest run components/home/evidence-gallery.test.tsx`

Expected: FAIL because `./evidence-gallery` does not exist.

- [ ] **Step 3: Implement the minimal native-dialog gallery**

Create a client component containing:

```tsx
'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './home.module.css';

const evidenceImages = [
  {
    src: '/evidence/v0.2.0-terminal.png',
    alt: 'v0.2.0 terminal showing the public doctor and demo passing',
    title: 'Terminal verification output',
    triggerLabel: 'Enlarge terminal verification screenshot',
    width: 1440,
    height: 900,
    caption: (
      <>
        The real user path: public <code>npx</code> commands, environment checks, and the final
        Docker demo result.
      </>
    ),
  },
  {
    src: '/evidence/v0.2.0-report.png',
    alt: 'v0.2.0 generated evidence report showing the passed response-loss scenario',
    title: 'Generated evidence report',
    triggerLabel: 'Enlarge generated evidence report screenshot',
    width: 1440,
    height: 960,
    caption: <>The generated HTML report is a human view of the same machine-readable artifact.</>,
  },
] as const;

export function EvidenceGallery() {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const activeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const selectedImage = selectedIndex === null ? null : evidenceImages[selectedIndex];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (selectedImage && dialog && !dialog.open) dialog.showModal();
  }, [selectedImage]);

  const finishClose = useCallback(() => {
    setSelectedIndex(null);
    activeTriggerRef.current?.focus();
  }, []);

  const closePreview = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    else finishClose();
  }, [finishClose]);

  return (
    <>
      <div className={styles.evidenceGallery}>
        {evidenceImages.map((image, index) => (
          <figure className={styles.evidenceFigure} key={image.src}>
            <button
              aria-haspopup="dialog"
              aria-label={image.triggerLabel}
              className={styles.evidenceImageButton}
              onClick={(event) => {
                activeTriggerRef.current = event.currentTarget;
                setSelectedIndex(index);
              }}
              type="button"
            >
              <Image alt={image.alt} height={image.height} src={image.src} width={image.width} />
              <span className={styles.evidenceZoomLabel}>Click to enlarge</span>
            </button>
            <figcaption>{image.caption}</figcaption>
          </figure>
        ))}
      </div>
      <dialog
        aria-labelledby="evidence-dialog-title"
        className={styles.evidenceDialog}
        onCancel={(event) => {
          event.preventDefault();
          closePreview();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closePreview();
        }}
        onClose={finishClose}
        ref={dialogRef}
      >
        {selectedImage ? (
          <div className={styles.evidenceDialogPanel} data-testid="evidence-dialog-panel">
            <header>
              <h3 id="evidence-dialog-title">{selectedImage.title}</h3>
              <button aria-label="Close image preview" onClick={closePreview} type="button">
                ×
              </button>
            </header>
            <Image
              alt={selectedImage.alt}
              height={selectedImage.height}
              src={selectedImage.src}
              unoptimized
              width={selectedImage.width}
            />
          </div>
        ) : null}
      </dialog>
    </>
  );
}
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm --filter @cashu-fault-lab/website exec vitest run components/home/evidence-gallery.test.tsx`

Expected: 3 tests pass.

### Task 2: Integrate, style, and browser-verify the lightbox

**Files:**

- Modify: `apps/website/components/home/evidence-report.tsx`
- Modify: `apps/website/components/home/home.module.css`
- Modify: `apps/website/components/home/home.test.tsx`
- Modify: `apps/website/e2e/portal.spec.ts`

**Interfaces:**

- Consumes: `EvidenceGallery()` from Task 1.
- Produces: a responsive landing-page lightbox reachable from both evidence screenshots.

- [ ] **Step 1: Add failing integration and browser assertions**

Update the home test to require both dialog triggers:

```tsx
expect(
  screen.getByRole('button', { name: 'Enlarge terminal verification screenshot' }),
).toBeVisible();
expect(
  screen.getByRole('button', { name: 'Enlarge generated evidence report screenshot' }),
).toBeVisible();
```

Add a Playwright test that opens the terminal image, verifies the modal image uses the original path, closes through ×, reopens and closes by backdrop, then reopens and closes with Escape:

```ts
test('evidence screenshots open clearly and support every close path', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Enlarge terminal verification screenshot' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Terminal verification output' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('img')).toHaveAttribute('src', '/evidence/v0.2.0-terminal.png');

  await dialog.getByRole('button', { name: 'Close image preview' }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeHidden();

  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
```

- [ ] **Step 2: Run the integration test and verify it fails**

Run: `pnpm --filter @cashu-fault-lab/website exec vitest run components/home/home.test.tsx`

Expected: FAIL because `EvidenceReport` still renders non-interactive images.

- [ ] **Step 3: Replace the static gallery and add responsive styles**

Remove the `next/image` import and inline gallery from `evidence-report.tsx`, import `EvidenceGallery`, and render `<EvidenceGallery />` in the same location.

Add CSS Module rules that:

```css
.evidenceImageButton {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: zoom-in;
  display: grid;
  padding: 0;
  position: relative;
  text-align: left;
  width: 100%;
}

.evidenceZoomLabel {
  background: rgba(7, 5, 15, 0.86);
  bottom: 0.75rem;
  color: var(--sand-100);
  font-family: 'IBM Plex Mono', monospace;
  font-size: 0.68rem;
  padding: 0.45rem 0.6rem;
  position: absolute;
  right: 0.75rem;
}

.evidenceDialog {
  background: transparent;
  border: 0;
  height: 100dvh;
  margin: 0;
  max-height: none;
  max-width: none;
  padding: clamp(0.75rem, 3vw, 2rem);
  width: 100vw;
}

.evidenceDialog[open] {
  display: grid;
  place-items: center;
}

.evidenceDialog::backdrop {
  background: rgba(5, 3, 12, 0.9);
}

.evidenceDialogPanel {
  background: var(--control-surface);
  border: 1px solid var(--sand-500);
  max-height: calc(100dvh - clamp(1.5rem, 6vw, 4rem));
  max-width: 1440px;
  overflow: auto;
  width: 100%;
}

.evidenceDialogPanel header {
  align-items: center;
  background: var(--control-surface);
  border-bottom: 1px solid var(--hairline);
  display: flex;
  justify-content: space-between;
  padding: 0.5rem 0.5rem 0.5rem 1rem;
  position: sticky;
  top: 0;
  z-index: 1;
}

.evidenceDialogPanel header button {
  align-items: center;
  background: transparent;
  border: 1px solid var(--hairline);
  color: var(--sand-100);
  cursor: pointer;
  display: inline-flex;
  font-size: 1.5rem;
  height: 44px;
  justify-content: center;
  width: 44px;
}

.evidenceDialogPanel img {
  display: block;
  height: auto;
  width: 100%;
}
```

- [ ] **Step 4: Run focused tests and Playwright**

Run: `pnpm --filter @cashu-fault-lab/website test`

Expected: all website tests pass.

Run: `pnpm website:test:e2e`

Expected: the new dialog test passes for desktop and mobile, all existing tests pass, and project-specific skips remain intentional.

- [ ] **Step 5: Run repository verification**

Run each command and require exit code 0:

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

- [ ] **Step 6: Commit and update PR #38**

```bash
git add apps/website/components/home/evidence-gallery.tsx apps/website/components/home/evidence-gallery.test.tsx apps/website/components/home/evidence-report.tsx apps/website/components/home/home.module.css apps/website/components/home/home.test.tsx apps/website/e2e/portal.spec.ts docs/superpowers/plans/2026-08-05-evidence-image-lightbox.md
git commit -m "feat(website): add evidence image lightbox"
git push
```
