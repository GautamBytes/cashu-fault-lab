import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const screenshotDirectory = path.join(import.meta.dirname, 'screenshots');
const publicRoutes = [
  '/',
  '/scenarios',
  '/architecture',
  '/release-status',
  '/docs/getting-started',
  '/docs/cli',
  '/docs/adapters',
  '/docs/delivery-profile',
  '/docs/invariants',
  '/docs/threat-model',
  '/docs/release-notes',
  '/docs/release-checklist',
] as const;

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  expect(dimensions.clientWidth).toBe(dimensions.innerWidth);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const scan = await new AxeBuilder({ page }).analyze();
  const violations = scan.violations.filter(
    ({ impact }) => impact === 'serious' || impact === 'critical',
  );

  expect(violations).toEqual([]);
}

async function saveScreenshot(page: Page, name: string) {
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    fullPage: true,
    path: path.join(screenshotDirectory, name),
  });
}

async function expectMinimumTouchTargets(page: Page, selector: string) {
  for (const control of await page.locator(selector).all()) {
    const box = await control.boundingBox();
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
}

test('home is accessible, has one visible title, and fits the viewport', async ({
  page,
}, testInfo) => {
  await page.goto('/');

  await expect(page.locator('h1:visible')).toHaveCount(1);
  await expectNoSeriousAccessibilityViolations(page);
  await expectNoPageOverflow(page);

  await saveScreenshot(
    page,
    testInfo.project.name === 'mobile-chromium' ? 'home-mobile.png' : 'home-desktop.png',
  );
});

test('documentation is accessible and wide code scrolls locally', async ({ page }, testInfo) => {
  await page.goto('/docs/getting-started');

  await expectNoSeriousAccessibilityViolations(page);
  await expectNoPageOverflow(page);

  const codeBlocks = page.locator('pre');
  await expect(codeBlocks.first()).toBeVisible();
  for (const codeBlock of await codeBlocks.all()) {
    const overflow = await codeBlock.evaluate((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    }));

    if (overflow.scrollWidth > overflow.clientWidth) {
      expect(['auto', 'scroll']).toContain(overflow.overflowX);
    }
  }

  await saveScreenshot(
    page,
    testInfo.project.name === 'mobile-chromium' ? 'docs-mobile.png' : 'docs-desktop.png',
  );
});

test('keyboard search navigates directly to a matching docs heading', async ({
  browserName,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');

  await page.goto('/');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.getByRole('searchbox', { name: 'Search documentation' }).fill('NUT-19');
  const dialog = page.getByRole('dialog', { name: 'Search documentation' });
  const closeButton = dialog.getByRole('button', { name: 'Close search' });
  const results = dialog.getByRole('link');
  const lastResult = results.last();

  await lastResult.focus();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(lastResult).toBeFocused();

  await dialog.getByRole('link', { name: /Delivery profile/ }).click();

  await expect(page).toHaveURL(/\/docs\/delivery-profile$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Delivery profile' })).toBeVisible();
  expect(browserName).toBe('chromium');
});

test('mobile menu reaches scenarios and exposes 44px controls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');

  const menu = page.getByRole('button', { name: 'Toggle primary navigation' });
  await page.goto('/');
  await menu.click();
  await expectMinimumTouchTargets(page, 'header a, header button');
  await page.getByRole('link', { name: 'Scenarios', exact: true }).click();
  await expect(page).toHaveURL(/\/scenarios$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Choose where delivery breaks',
  );

  await expectMinimumTouchTargets(page, 'button, header a, main article > a');
  await expectNoPageOverflow(page);

  await page.goto('/docs/getting-started');
  await expectMinimumTouchTargets(page, 'button, header a, aside a, nav a, article a');
});

test('reduced motion is exposed as a timeline data signal', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByLabel('Six-stage response-loss recovery flow')).toHaveAttribute(
    'data-motion',
    'reduced',
  );
});

test('every public route fits desktop and mobile viewports', async ({ page }) => {
  for (const route of publicRoutes) {
    await page.goto(route);
    await expectNoPageOverflow(page);
  }
});

test('public routes expose canonical metadata and discovery endpoints', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');

  for (const route of publicRoutes) {
    await page.goto(route);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      route === '/' ? 'http://localhost:3000' : `http://localhost:3000${route}`,
    );
  }

  await page.goto('/');
  await expect(page).toHaveTitle('Cashu Fault Lab');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /experimental developer preview/i,
  );
  const jsonLd = await page.locator('script[type="application/ld+json"]').textContent();
  expect(jsonLd).toContain('"applicationCategory":"DeveloperApplication"');
  expect(jsonLd).not.toContain('<');

  await page.goto('/docs/getting-started');
  await expect(page).toHaveTitle('Getting started | Cashu Fault Lab');

  const [sitemap, robots, manifest, openGraphImage] = await Promise.all([
    page.request.get('/sitemap.xml'),
    page.request.get('/robots.txt'),
    page.request.get('/manifest.webmanifest'),
    page.request.get('/opengraph-image'),
  ]);
  expect(sitemap.ok()).toBe(true);
  expect(await sitemap.text()).toContain('/docs/release-checklist');
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toContain('Allow: /');
  expect(manifest.ok()).toBe(true);
  expect(await manifest.json()).toMatchObject({
    background_color: '#f6ebd6',
    theme_color: '#2b0c4a',
  });
  expect(openGraphImage.ok()).toBe(true);
  expect(openGraphImage.headers()['content-type']).toContain('image/png');
});

test('not found page offers recovery actions', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');

  await page.goto('/this-route-does-not-exist');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('not found');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  const recoveryActions = page.getByLabel('Recovery actions');
  const searchAction = recoveryActions.getByRole('button', { name: 'Search documentation' });
  await expect(searchAction).toBeVisible();
  await expect(recoveryActions.getByRole('link', { name: 'Getting started' })).toBeVisible();
  await expect(recoveryActions.getByRole('link', { name: 'Scenarios' })).toBeVisible();
  await expect(recoveryActions.getByRole('link', { name: /GitHub/ })).toBeVisible();

  await searchAction.click();
  await expect(page.getByRole('dialog', { name: 'Search documentation' })).toBeVisible();
});
