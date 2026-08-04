# Evidence image lightbox design

## Goal

Let landing-page visitors inspect both v0.2.0 evidence screenshots at their original resolution without leaving the page, while providing obvious and accessible ways to dismiss the enlarged view.

## Scope

The feature applies only to the two screenshots in the landing page evidence gallery. It does not add galleries, image downloads, zoom controls, keyboard image navigation, or a third-party lightbox dependency.

## Interaction design

Each evidence screenshot becomes a labeled button while preserving its existing figure and caption. Activating a screenshot opens a modal containing the original image and a visible close button marked with an × icon.

The modal closes when the visitor:

- activates the close button;
- clicks the backdrop outside the image panel; or
- presses Escape.

Clicks inside the image panel do not close the modal. Closing restores keyboard focus to the screenshot button that opened it.

## Architecture

Create a focused client component for the interactive gallery. The existing evidence report remains responsible for presenting result data and links; the new component owns only the selected-image state and modal lifecycle.

Use the browser's native `<dialog>` element through `showModal()` and `close()`. This provides top-layer rendering, modal semantics, Escape handling, and focus restoration without an external dependency. The dialog receives an accessible title linked through `aria-labelledby`.

Each image descriptor contains its source, alternative text, dimensions, caption, and dialog title. The gallery renders these descriptors consistently and passes the selected descriptor into the dialog.

## Visual behavior

Thumbnail buttons retain the current two-column desktop and single-column narrow layout. A small “Click to enlarge” affordance and pointer cursor make the interaction discoverable.

The dialog backdrop dims the page. The image panel is bounded by the viewport, preserves the source aspect ratio, and allows internal scrolling when the image is taller than the available space. On mobile, the panel uses nearly the full viewport and keeps the close control at least 44 by 44 CSS pixels.

Reduced-motion preferences disable any optional transition. The interaction does not depend on animation.

## Error and fallback behavior

The checked-in images and dimensions remain static build inputs, so runtime loading errors do not require application recovery logic. If JavaScript is unavailable, the existing images remain visible at their responsive inline size; only enlargement is unavailable.

The client component guards calls to `showModal()` and `close()` so test environments and repeated state updates do not throw when the dialog is already in the requested state.

## Accessibility

- Thumbnail buttons have explicit accessible names describing enlargement.
- The modal uses native dialog semantics and `aria-modal` behavior from `showModal()`.
- The close control has an explicit “Close image preview” label.
- Escape closes the dialog through the native cancel behavior.
- Focus returns to the activating thumbnail after close.
- Backdrop clicks close only when the dialog itself is the click target.
- Images keep descriptive alternative text in both inline and enlarged views.

## Testing

Component tests must first fail against the current static gallery, then verify:

- both screenshots are exposed as enlargement buttons;
- activating either button opens a dialog with the correct full-resolution image and title;
- the close button dismisses the dialog;
- clicking the backdrop dismisses the dialog;
- clicking inside the panel does not dismiss the dialog;
- Escape dismisses the dialog; and
- focus returns to the activating button.

Existing evidence-content, typecheck, unit, production-build, and Playwright viewport/accessibility gates must remain green.

## Acceptance criteria

Visitors can open either evidence screenshot in a clear full-resolution modal and reliably close it using ×, backdrop click, or Escape on desktop and mobile. The interaction is keyboard accessible, introduces no new package dependency, and does not change the evidence claims or retained artifacts.
