'use client';

import { useEffect } from 'react';

const REFRESH_EVENT = 'cashu-fault-lab:refresh-scroll-reveal';
const INITIAL_VIEWPORT_RATIO = 0.88;

function revealableSections(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('main section')].filter(
    (section) =>
      section.dataset.scrollReveal !== 'off' && section.closest('aside, details, nav') === null,
  );
}

export function ScrollReveal() {
  useEffect(() => {
    let observer: IntersectionObserver | undefined;

    function revealSections() {
      observer?.disconnect();
      const sections = revealableSections();
      const reducedMotion =
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

      if (reducedMotion || typeof window.IntersectionObserver === 'undefined') {
        for (const section of sections) {
          section.dataset.scrollReveal = 'visible';
        }
        return;
      }

      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            (entry.target as HTMLElement).dataset.scrollReveal = 'visible';
            observer?.unobserve(entry.target);
          }
        },
        {
          rootMargin: '0px 0px -8% 0px',
          threshold: 0.12,
        },
      );

      const immediateBoundary = window.innerHeight * INITIAL_VIEWPORT_RATIO;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= immediateBoundary) {
          section.dataset.scrollReveal = 'visible';
          continue;
        }

        section.dataset.scrollReveal = 'pending';
        observer.observe(section);
      }
    }

    revealSections();
    window.addEventListener(REFRESH_EVENT, revealSections);

    return () => {
      observer?.disconnect();
      window.removeEventListener(REFRESH_EVENT, revealSections);
    };
  }, []);

  return null;
}
