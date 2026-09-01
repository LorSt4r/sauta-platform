import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { cleanupE2eTest, setupE2eTest } from './e2e-helper';

describe('Frontend PWA — capability wallet e tenant autorevole', () => {
  let browser: Browser;
  let page: Page;
  let baseUrl: string;

  beforeAll(async () => {
    const setup = await setupE2eTest();
    baseUrl = setup.baseUrl;
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    page = await browser.newPage();
  }, 90000);

  afterAll(async () => {
    await browser?.close();
    await cleanupE2eTest();
  });

  it('invia la capability solo nel body e rende payload XSS come testo inerte', async () => {
    const sessionId = 'session-browser-xss';
    const walletToken = `swc_${'a'.repeat(64)}`;
    const venueName = '<img src=x onerror="window.__walletXss = true">Venue';
    const productName = '<script>window.__walletXss = true</script>Drink';
    let walletRequestUrl = '';
    let walletRequestBody: unknown;
    let dialogOpened = false;

    page.on('dialog', async (dialog) => {
      dialogOpened = true;
      await dialog.dismiss();
    });
    await page.addInitScript(({ id, token }) => {
      localStorage.setItem('sauta_onboarding_seen', 'true');
      localStorage.setItem('sauta_wallet', JSON.stringify([{ sessionId: id, token }]));
    }, { id: sessionId, token: walletToken });

    await page.route('https://js.stripe.com/**', async (route) => {
      await route.fulfill({
        contentType: 'application/javascript',
        body: `
          window.Stripe = () => ({
            paymentRequest: () => ({
              canMakePayment: async () => null,
              on: () => {},
              update: () => {}
            }),
            elements: () => ({ create: () => ({ mount: () => {} }) })
          });
        `,
      });
    });
    await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
    await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
    await page.route((url) => url.pathname === '/api/config', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ stripePublishableKey: 'pk_test_browser' }),
    }));
    await page.route((url) => url.pathname === '/api/venue/current', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ venue: { name: 'Demo Sauta', hostname: 'demo.localhost' } }),
    }));
    await page.route((url) => url.pathname === '/api/venue/current/menu', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ products: [{ id: 'p1', slug: 'mojito', name: 'Mojito', price: 900 }] }),
    }));
    await page.route((url) => url.pathname === '/api/daily-seed', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ seed: 42, date: '2026-07-24' }),
    }));
    await page.route('**/api/wallet/query', async (route) => {
      walletRequestUrl = route.request().url();
      walletRequestBody = route.request().postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [{
            session: {
              id: sessionId,
              totalAmount: 1000,
              currency: 'EUR',
              status: 'paid',
              fiscalStatus: 'invoiced',
              digitalConsent: true,
              createdAt: '2026-07-24T10:00:00.000Z',
            },
            venue: { id: 'venue-xss', name: venueName },
            tickets: [{
              id: 'ticket-xss',
              productName,
              price: 1000,
              status: 'valid',
              usedAt: null,
              createdAt: '2026-07-24T10:00:00.000Z',
            }],
          }],
        }),
      });
    });

    const navigationResponse = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    expect(navigationResponse?.status()).toBe(200);
    const csp = navigationResponse?.headers()['content-security-policy'] ?? '';
    const scriptDirective = csp.split(';').find((directive) =>
      directive.trim().startsWith('script-src ')
    ) ?? '';
    expect(scriptDirective).not.toContain("'unsafe-inline'");

    await page.locator('#wallet-btn').click();
    await page.locator('.history-card h4').waitFor();
    expect(await page.locator('.history-card h4').textContent()).toBe(venueName);
    expect(await page.locator('.ticket-card h3').textContent()).toBe(productName);

    expect(walletRequestUrl).not.toContain(walletToken);
    expect(walletRequestBody).toEqual({
      items: [{ sessionId, token: walletToken }],
    });
    expect(dialogOpened).toBe(false);
    expect(await page.evaluate(() => (window as Window & { __walletXss?: boolean }).__walletXss))
      .not.toBe(true);
    expect(await page.locator('#wallet-content script, #wallet-content img').count()).toBe(0);
  });

  it('renderizza dinamicamente soltanto i prodotti dal menu server (incluso slug personalizzato)', async () => {
    const customPage = await browser.newPage();
    await customPage.addInitScript(() => {
      localStorage.setItem('sauta_onboarding_seen', 'true');
    });
    await customPage.route('https://js.stripe.com/**', async (route) => {
      await route.fulfill({
        contentType: 'application/javascript',
        body: `
          window.Stripe = () => ({
            paymentRequest: () => ({
              canMakePayment: async () => null,
              on: () => {},
              update: () => {}
            }),
            elements: () => ({ create: () => ({ mount: () => {} }) })
          });
        `,
      });
    });
    await customPage.route('https://fonts.googleapis.com/**', (route) => route.abort());
    await customPage.route('https://fonts.gstatic.com/**', (route) => route.abort());
    await customPage.route((url) => url.pathname === '/api/config', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ stripePublishableKey: 'pk_test_browser' }),
    }));
    await customPage.route((url) => url.pathname === '/api/venue/current', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ venue: { name: 'Custom Club', hostname: 'demo.localhost' } }),
    }));
    await customPage.route((url) => url.pathname === '/api/venue/current/menu', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        products: [
          { id: 'p_custom', slug: 'special-dragon-cocktail', name: 'Special Dragon Cocktail', price: 1500 },
        ],
      }),
    }));
    await customPage.route((url) => url.pathname === '/api/daily-seed', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ seed: 42, date: '2026-07-24' }),
    }));

    await customPage.goto(baseUrl, { waitUntil: 'load' });
    await customPage.locator('#menu-drinks-grid .product-card').waitFor();

    expect(await customPage.locator('.header-content h1').textContent()).toBe('Custom Club');
    expect(await customPage.locator('#menu-drinks-grid .product-card').count()).toBe(1);
    expect(await customPage.locator('#menu-drinks-grid .product-info h3').textContent()).toBe('Special Dragon Cocktail');
    expect(await customPage.locator('#menu-drinks-grid .price').textContent()).toBe('€15.00');
    expect(await customPage.locator('.compliance-footer').textContent()).not.toContain('Demo Venue');
    await customPage.locator('[data-legal-type="privacy"]').click();
    expect(await customPage.locator('#legal-modal-body').textContent()).not.toContain('Demo Venue');

    await customPage.close();
  });

  it('non inizializza Stripe e disabilita gli acquisti quando /api/config non è disponibile', async () => {
    const unavailablePage = await browser.newPage();
    await unavailablePage.route('https://js.stripe.com/**', async (route) => {
      await route.fulfill({
        contentType: 'application/javascript',
        body: `
          window.Stripe = () => {
            window.__stripeInitCount = (window.__stripeInitCount || 0) + 1;
            return {};
          };
        `,
      });
    });
    await unavailablePage.route('https://fonts.googleapis.com/**', (route) => route.abort());
    await unavailablePage.route('https://fonts.gstatic.com/**', (route) => route.abort());
    await unavailablePage.route((url) => url.pathname === '/api/config', (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unavailable' }),
    }));
    await unavailablePage.route((url) => url.pathname === '/api/venue/current', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ venue: { name: 'Custom Club', hostname: 'demo.localhost' } }),
    }));
    await unavailablePage.route((url) => url.pathname === '/api/venue/current/menu', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        products: [{ id: 'p1', slug: 'mojito', name: 'Mojito', price: 900 }],
      }),
    }));
    await unavailablePage.route((url) => url.pathname === '/api/daily-seed', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ seed: 42, date: '2026-07-27' }),
    }));

    await unavailablePage.goto(baseUrl, { waitUntil: 'load' });
    await expect.poll(async () => unavailablePage.locator('.header-content h1').textContent())
      .toBe('Servizio non disponibile');

    expect(await unavailablePage.evaluate(
      () => (window as Window & { __stripeInitCount?: number }).__stripeInitCount ?? 0
    )).toBe(0);
    expect(await unavailablePage.locator('#menu-drinks-grid button').isDisabled()).toBe(true);

    await unavailablePage.close();
  });
});
