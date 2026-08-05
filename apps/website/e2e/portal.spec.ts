import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const screenshotDirectory = path.join(process.cwd(), 'test-results/website/screenshots');
const publicRoutes = [
  '/',
  '/scenarios',
  '/architecture',
  '/release-status',
  '/docs/getting-started',
  '/docs/contributing',
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

async function expectNoElementClipping(element: Locator) {
  await expect(element).toBeVisible();
  const dimensions = await element.evaluate((node) => ({
    clientHeight: node.clientHeight,
    clientWidth: node.clientWidth,
    overflowY: getComputedStyle(node).overflowY,
    scrollHeight: node.scrollHeight,
    scrollWidth: node.scrollWidth,
  }));

  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  if (['auto', 'clip', 'hidden', 'scroll'].includes(dimensions.overflowY)) {
    expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.clientHeight + 1);
  }
}

async function expectElementInside(element: Locator, container: Locator) {
  const [elementBox, containerBox] = await Promise.all([
    element.boundingBox(),
    container.boundingBox(),
  ]);

  expect(elementBox).not.toBeNull();
  expect(containerBox).not.toBeNull();
  if (!elementBox || !containerBox) return;

  expect(elementBox.x).toBeGreaterThanOrEqual(containerBox.x - 1);
  expect(elementBox.x + elementBox.width).toBeLessThanOrEqual(
    containerBox.x + containerBox.width + 1,
  );
  expect(elementBox.y).toBeGreaterThanOrEqual(containerBox.y - 1);
  expect(elementBox.y + elementBox.height).toBeLessThanOrEqual(
    containerBox.y + containerBox.height + 1,
  );
}

test('home is accessible, has one visible title, and fits the viewport', async ({
  page,
}, testInfo) => {
  await page.goto('/');

  const codespacesAction = page.getByRole('link', { name: 'Open in Codespaces' });
  await expect(codespacesAction).toBeVisible();
  await expect(codespacesAction).toHaveAttribute(
    'href',
    'https://codespaces.new/GautamBytes/cashu-fault-lab?quickstart=1',
  );
  await codespacesAction.focus();
  await expect(codespacesAction).toBeFocused();
  await codespacesAction.evaluate((element) => element.blur());
  const demoCommand = page.getByLabel('Demo command', { exact: true });
  const copyCommand = demoCommand.getByRole('button', { name: 'Copy demo command' });
  await expect(demoCommand.getByText('npx --yes cashu-fault-lab@0.2.0 demo')).toBeVisible();
  await expect(copyCommand).toBeVisible();
  await expect(demoCommand.getByText('npx --yes cashu-fault-lab@0.2.0 demo')).toHaveCSS(
    'white-space',
    'nowrap',
  );
  await expectElementInside(copyCommand, demoCommand);

  if (testInfo.project.name === 'desktop-chromium') {
    const viewportHeight = page.viewportSize()?.height ?? 900;
    const hero = page.getByRole('region', { name: 'Make Cashu delivery fail safely.' });
    const productHeading = hero.getByRole('heading', {
      level: 1,
      name: 'Make Cashu delivery fail safely.',
    });
    const primaryAction = hero.getByRole('link', { name: 'Run the verified demo' });
    await expect(primaryAction).toHaveAttribute('href', '#verified-run');
    const githubAction = hero.getByRole('link', { name: /View on GitHub/ });
    const commandBlock = hero.getByLabel('Demo command', { exact: true });
    const runPanel = hero.getByRole('complementary', { name: 'Deterministic demo run' });

    for (const element of [productHeading, primaryAction, githubAction, commandBlock, runPanel]) {
      await expect(element).toBeVisible();
      const elementBox = await element.boundingBox();
      expect(elementBox).not.toBeNull();
      if (elementBox) {
        expect(elementBox.y).toBeGreaterThanOrEqual(0);
        expect(elementBox.y + elementBox.height).toBeLessThanOrEqual(viewportHeight);
      }
    }

    const heroBox = await hero.boundingBox();
    const trace = page.getByRole('region', {
      name: 'A lost response is not a lost result.',
    });
    const traceSectionBox = await trace.boundingBox();
    const traceHeading = page.getByRole('heading', { name: /lost response/i });

    await expect(traceHeading).toBeVisible();
    expect(heroBox?.height).toBeLessThanOrEqual(820);
    expect(traceSectionBox?.y).toBeLessThan(viewportHeight);
  }

  await expect(page.locator('h1:visible')).toHaveCount(1);
  await expectNoSeriousAccessibilityViolations(page);
  await expectNoPageOverflow(page);

  if (testInfo.project.name === 'mobile-chromium') {
    const integrationHeading = page.getByRole('heading', {
      name: 'Integrate and validate without changing implementation behavior.',
    });
    const headingWidth = await integrationHeading.evaluate((heading) => ({
      clientWidth: heading.clientWidth,
      scrollWidth: heading.scrollWidth,
    }));

    expect(headingWidth.scrollWidth).toBeLessThanOrEqual(headingWidth.clientWidth);
  }

  await saveScreenshot(
    page,
    testInfo.project.name === 'mobile-chromium' ? 'home-mobile.png' : 'home-desktop.png',
  );
});

test('evidence screenshots open clearly and support every close path', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const trigger = page.getByRole('button', {
    name: 'Enlarge terminal verification screenshot',
  });

  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Terminal verification output' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('img')).toHaveAttribute('src', '/evidence/v0.2.0-terminal.png');
  await expect(dialog.getByRole('link', { name: 'Open original image' })).toHaveAttribute(
    'href',
    '/evidence/v0.2.0-terminal.png',
  );
  if (testInfo.project.name === 'mobile-chromium') {
    const panel = dialog.getByTestId('evidence-dialog-panel');
    const dimensions = await panel.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));

    expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
    await expectNoPageOverflow(page);
  }
  await expectNoSeriousAccessibilityViolations(page);
  await mkdir(screenshotDirectory, { recursive: true });
  await dialog.screenshot({
    animations: 'disabled',
    path: path.join(
      screenshotDirectory,
      testInfo.project.name === 'mobile-chromium'
        ? 'evidence-modal-mobile.png'
        : 'evidence-modal-desktop.png',
    ),
  });

  await dialog.getByRole('button', { name: 'Close image preview' }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('user laptop viewport shows the complete hero and next section cue', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');

  await page.setViewportSize({ width: 1905, height: 781 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  const hero = page.getByRole('region', { name: 'Make Cashu delivery fail safely.' });
  const requiredElements = [
    hero.getByRole('heading', { level: 1, name: 'Make Cashu delivery fail safely.' }),
    hero.locator('h1 + p'),
    hero.getByRole('link', { name: 'Run the verified demo' }),
    hero.getByRole('link', { name: 'Open in Codespaces' }),
    hero.getByRole('link', { name: /View on GitHub/ }),
    hero.getByLabel('Demo command', { exact: true }),
    hero.getByRole('complementary', { name: 'Deterministic demo run' }),
  ];
  const requiredElementBottoms: number[] = [];

  for (const element of requiredElements) {
    const elementBox = await element.boundingBox();
    expect(elementBox).not.toBeNull();
    if (elementBox) {
      expect(elementBox.y).toBeGreaterThanOrEqual(0);
      expect(elementBox.y + elementBox.height).toBeLessThanOrEqual(781);
      requiredElementBottoms.push(elementBox.y + elementBox.height);
    }
  }

  const evidenceCue = hero.getByText('Next / verified run evidence');
  await expect(evidenceCue).toBeVisible();
  const evidenceCueBox = await evidenceCue.boundingBox();
  expect(evidenceCueBox).not.toBeNull();
  expect(evidenceCueBox?.y).toBeGreaterThanOrEqual(Math.max(...requiredElementBottoms) + 12);
  expect((evidenceCueBox?.y ?? 0) + (evidenceCueBox?.height ?? 0)).toBeLessThanOrEqual(781);

  const verifiedRun = page.getByRole('group', { name: 'Verified public-package run' });
  const verifiedRunBox = await verifiedRun.boundingBox();

  expect(verifiedRunBox?.y).toBeLessThan(781);
  await expect(page.getByLabel('Six-stage response-loss recovery flow')).toHaveAttribute(
    'data-motion',
    'reduced',
  );
  await expectNoPageOverflow(page);

  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    fullPage: false,
    path: path.join(screenshotDirectory, 'home-user-viewport.png'),
  });
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

test('release status assigns every open gate to an external validator', async ({
  page,
}, testInfo) => {
  await page.goto('/release-status');

  await expect(
    page.getByRole('heading', { level: 1, name: 'Awaiting independent validation.' }),
  ).toBeVisible();
  await expect(page.getByText('Independent wallet maintainer')).toBeVisible();
  await expect(page.getByText('Cashu protocol reviewer')).toBeVisible();
  const validationWork = page.getByText('Independent validation work').locator('..');
  await expect(validationWork.getByText('Check', { exact: true })).toHaveCount(5);
  await expect(validationWork.getByText('Expected artifact', { exact: true })).toHaveCount(5);
  await expectNoSeriousAccessibilityViolations(page);
  await expectNoPageOverflow(page);

  await saveScreenshot(
    page,
    testInfo.project.name === 'mobile-chromium'
      ? 'release-status-mobile.png'
      : 'release-status-desktop.png',
  );
});

test('Architecture participates in docs navigation, search, and pagination', async ({
  page,
}, testInfo) => {
  await page.goto('/docs/adapters');
  await page
    .getByRole('navigation', { name: 'Document pagination' })
    .getByRole('link', { name: /Next\s*Wallet lifecycle/ })
    .click();

  await expect(page).toHaveURL(/\/docs\/wallet-lifecycle$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet lifecycle' })).toBeVisible();
  const lifecyclePagination = page.getByRole('navigation', { name: 'Document pagination' });
  await expect(
    lifecyclePagination.getByRole('link', { name: /Previous\s*Adapter guide/ }),
  ).toHaveAttribute('href', '/docs/adapters');
  await lifecyclePagination.getByRole('link', { name: /Next\s*NIP-60 wallet doctor/ }).click();

  await expect(page).toHaveURL(/\/docs\/wallet-doctor$/);
  await expect(page.getByRole('heading', { level: 1, name: 'NIP-60 wallet doctor' })).toBeVisible();
  const doctorPagination = page.getByRole('navigation', { name: 'Document pagination' });
  await expect(
    doctorPagination.getByRole('link', { name: /Previous\s*Wallet lifecycle/ }),
  ).toHaveAttribute('href', '/docs/wallet-lifecycle');
  await doctorPagination.getByRole('link', { name: /Next\s*Architecture/ }).click();

  await expect(page).toHaveURL(/\/architecture$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Faults travel. Trust does not.' }),
  ).toBeVisible();

  if (testInfo.project.name === 'mobile-chromium') {
    await page.getByText('Browse documentation', { exact: true }).click();
  }

  await expect(page.locator('header summary').filter({ hasText: 'Explore' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const pagination = page.getByRole('navigation', { name: 'Document pagination' });
  await expect(
    pagination.getByRole('link', { name: /Previous\s*NIP-60 wallet doctor/ }),
  ).toHaveAttribute('href', '/docs/wallet-doctor');
  await expect(pagination.getByRole('link', { name: /Next\s*Delivery profile/ })).toHaveAttribute(
    'href',
    '/docs/delivery-profile',
  );

  if (testInfo.project.name === 'mobile-chromium') {
    await page.getByRole('button', { name: 'Toggle primary navigation' }).click();
  }
  await page.getByRole('button', { name: 'Search documentation' }).click();
  await page
    .getByRole('searchbox', { name: 'Search documentation' })
    .fill('Recovery behavior is not release evidence');
  const architectureHeadingResult = page
    .getByRole('dialog', { name: 'Search documentation' })
    .getByRole('link', { name: /^Recovery behavior is not release evidence\./ });
  await expect(architectureHeadingResult).toHaveAttribute('href', '/architecture#separation-title');
  await architectureHeadingResult.click();
  await expect(page).toHaveURL(/\/architecture#separation-title$/);
  await expect(
    page.getByRole('heading', {
      level: 2,
      name: 'Recovery behavior is not release evidence.',
    }),
  ).toBeVisible();

  await page.goto('/architecture');

  await expectNoSeriousAccessibilityViolations(page);
  await expectNoPageOverflow(page);
  await saveScreenshot(
    page,
    testInfo.project.name === 'mobile-chromium'
      ? 'architecture-mobile.png'
      : 'architecture-desktop.png',
  );
});

test('tablet hero stacks without clipping the command or run evidence', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  const hero = page.getByRole('region', { name: 'Make Cashu delivery fail safely.' });
  const heading = hero.getByRole('heading', {
    level: 1,
    name: 'Make Cashu delivery fail safely.',
  });
  const primaryAction = hero.getByRole('link', { name: 'Run the verified demo' });
  const actions = primaryAction.locator('..');
  const command = hero.getByLabel('Demo command', { exact: true });
  const copyButton = command.getByRole('button', { name: 'Copy demo command' });
  const runPanel = hero.getByRole('complementary', { name: 'Deterministic demo run' });

  for (const element of [heading, actions, command, copyButton, runPanel]) {
    await expectNoElementClipping(element);
    await expectElementInside(element, hero);
  }

  const [commandBox, runPanelBox] = await Promise.all([
    command.boundingBox(),
    runPanel.boundingBox(),
  ]);
  expect(commandBox).not.toBeNull();
  expect(runPanelBox).not.toBeNull();
  if (commandBox && runPanelBox) {
    expect(runPanelBox.y).toBeGreaterThanOrEqual(commandBox.y + commandBox.height + 24);
  }

  await expectNoPageOverflow(page);
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    fullPage: false,
    path: path.join(screenshotDirectory, 'home-tablet.png'),
  });
});

test('mobile documentation heading uses a fixed responsive step', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');

  const headingSizeAt = async (width: number) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/docs/getting-started');

    return page
      .getByRole('heading', { level: 1, name: 'Getting started' })
      .evaluate((heading) => Number.parseFloat(getComputedStyle(heading).fontSize));
  };

  const narrowHeadingSize = await headingSizeAt(390);
  const wideHeadingSize = await headingSizeAt(430);

  expect(wideHeadingSize).toBe(narrowHeadingSize);
});

test('keyboard search navigates directly to a matching docs heading', async ({
  browserName,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-search-shortcut-ready', 'true');
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

  await dialog.getByRole('link', { name: /^Upstream basis/ }).click();

  await expect(page).toHaveURL(/\/docs\/delivery-profile#upstream-basis$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Delivery profile' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Upstream basis' })).toBeVisible();
  expect(browserName).toBe('chromium');
});

test('mobile menu exposes compact navigation and 44px controls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');

  const menu = page.getByRole('button', { name: 'Toggle primary navigation' });
  await page.goto('/');
  await menu.click();
  await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Docs', exact: true })).toBeVisible();
  const explore = page.locator('header summary').filter({ hasText: 'Explore' });
  await expect(explore).toBeVisible();
  await explore.click();
  await expect(page.getByRole('link', { name: 'Release status', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Scenarios', exact: true })).toBeVisible();
  await expectMinimumTouchTargets(page, 'header a, header button');
  await page.getByRole('link', { name: 'Docs', exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/getting-started$/);
  const docsNavigation = page.getByText('Browse documentation', { exact: true });
  await expect(docsNavigation).toBeVisible();
  await docsNavigation.click();
  await expectMinimumTouchTargets(page, 'button, header a, aside a, nav a, article a');
  await expectNoPageOverflow(page);
});

test('mobile empty search exposes a 44px recovery link', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');

  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle primary navigation' }).click();
  await page.getByRole('button', { name: 'Search documentation' }).click();
  await page
    .getByRole('searchbox', { name: 'Search documentation' })
    .fill('cashu-fault-lab-guaranteed-zero-result-7f0f1e');

  const recoveryLink = page.getByRole('link', { name: 'Browse scenarios' });
  await expect(recoveryLink).toBeVisible();
  const recoveryBox = await recoveryLink.boundingBox();

  expect(recoveryBox).not.toBeNull();
  expect(recoveryBox?.width).toBeGreaterThanOrEqual(44);
  expect(recoveryBox?.height).toBeGreaterThanOrEqual(44);
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

test('color theme follows the system and persists an explicit choice', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');

  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Toggle color theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('every public route is accessible and fits desktop and mobile viewports', async ({ page }) => {
  for (const route of publicRoutes) {
    await page.goto(route);
    await expectNoSeriousAccessibilityViolations(page);
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
  expect(await sitemap.text()).toContain('/architecture');
  expect(await sitemap.text()).toContain('/docs/release-checklist');
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toContain('Allow: /');
  expect(manifest.ok()).toBe(true);
  expect(await manifest.json()).toMatchObject({
    background_color: '#09070d',
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
