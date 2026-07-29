import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrollReveal } from './scroll-reveal';

const globalsCss = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');

let intersectionCallback: IntersectionObserverCallback | undefined;

class IntersectionObserverStub {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();

  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }
}

function stubMotionPreference(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: reduced,
      removeEventListener: vi.fn(),
    })),
  );
}

function position(element: HTMLElement, top: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    bottom: top + 200,
    height: 200,
    left: 0,
    right: 800,
    toJSON: vi.fn(),
    top,
    width: 800,
    x: 0,
    y: top,
  });
}

afterEach(() => {
  intersectionCallback = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ScrollReveal', () => {
  it('keeps initial content visible and reveals later sections once', () => {
    stubMotionPreference(false);
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
    vi.stubGlobal('innerHeight', 800);

    render(
      <>
        <ScrollReveal />
        <main>
          <section>First viewport</section>
          <section>Below fold</section>
          <nav>
            <section>Navigation group</section>
          </nav>
        </main>
      </>,
    );

    const first = screen.getByText('First viewport').closest('section');
    const belowFold = screen.getByText('Below fold').closest('section');
    const navigation = screen.getByText('Navigation group').closest('section');
    if (!first || !belowFold || !navigation) throw new Error('Expected test sections');

    position(first, 120);
    position(belowFold, 920);
    position(navigation, 920);

    act(() => {
      window.dispatchEvent(new Event('cashu-fault-lab:refresh-scroll-reveal'));
    });

    expect(first).toHaveAttribute('data-scroll-reveal', 'visible');
    expect(belowFold).toHaveAttribute('data-scroll-reveal', 'pending');
    expect(navigation).not.toHaveAttribute('data-scroll-reveal');

    act(() => {
      const bounds = belowFold.getBoundingClientRect();
      intersectionCallback?.(
        [
          {
            boundingClientRect: bounds,
            intersectionRatio: 1,
            intersectionRect: bounds,
            isIntersecting: true,
            rootBounds: null,
            target: belowFold,
            time: 0,
          },
        ],
        {} as IntersectionObserver,
      );
    });

    expect(belowFold).toHaveAttribute('data-scroll-reveal', 'visible');
  });

  it('uses a perceptible blur-to-focus reveal without animating layout', () => {
    expect(globalsCss).toMatch(
      /\[data-scroll-reveal='pending'\]\s*\{[^}]*filter:\s*blur\(10px\);[^}]*opacity:\s*0;[^}]*transform:\s*translate3d\(0, 1\.75rem, 0\)/s,
    );
    expect(globalsCss).toMatch(
      /\[data-scroll-reveal='visible'\]\s*\{[^}]*filter:\s*blur\(0\);[\s\S]*filter 600ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/,
    );
  });

  it('shows every section immediately when reduced motion is requested', () => {
    stubMotionPreference(true);
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);

    render(
      <>
        <ScrollReveal />
        <main>
          <section>Reduced motion content</section>
        </main>
      </>,
    );

    expect(screen.getByText('Reduced motion content').closest('section')).toHaveAttribute(
      'data-scroll-reveal',
      'visible',
    );
    expect(intersectionCallback).toBeUndefined();
    expect(globalsCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-scroll-reveal\]/,
    );
  });
});
