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
                <span aria-hidden="true">×</span>
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
