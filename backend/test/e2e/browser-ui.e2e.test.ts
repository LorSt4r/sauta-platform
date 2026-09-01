import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupE2eTest, setupE2eTest } from './e2e-helper';

const screenshotDir =
  process.env.SAUTA_UI_ARTIFACT_DIR || path.join(os.tmpdir(), 'sauta-ui-audit');

async function createBrowserContext(
  browser: Browser,
  viewport: { width: number; height: number },
  captureCheckout = false,
): Promise<{ context: BrowserContext; page: Page; pageErrors: string[] }> {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  });

  await context.addInitScript(({ shouldCaptureCheckout }) => {
    localStorage.setItem('sauta_onboarding_seen', 'true');

    if (!shouldCaptureCheckout) return;

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      const request = args[0];
      const url = typeof request === 'string' ? request : request instanceof URL
        ? request.toString()
        : request.url;
      const method = args[1]?.method || (typeof request === 'string' || request instanceof URL
        ? 'GET'
        : request.method);

      if (new URL(url, window.location.href).pathname === '/api/checkout' && method === 'POST') {
        const payload = await response.clone().json();
        (window as Window & { __sautaLastSessionId?: string }).__sautaLastSessionId =
          payload.sessionId;
      }

      return response;
    };
  }, { shouldCaptureCheckout: captureCheckout });

  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.route('https://js.stripe.com/**', async (route) => {
    await route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.Stripe = () => {
          const paymentRequest = {
            canMakePayment: async () => ({ applePay: true }),
            on: (eventName, handler) => {
              if (eventName === 'paymentmethod') {
                window.__sautaPaymentHandler = handler;
              }
            },
            update: () => {}
          };

          return {
            paymentRequest: () => paymentRequest,
            elements: () => ({
              create: () => ({
                mount: (selector) => {
                  const container = document.querySelector(selector);
                  const button = document.createElement('button');
                  button.id = 'browser-wallet-pay';
                  button.type = 'button';
                  button.className = 'btn-apple-pay';
                  button.textContent = 'Paga con wallet di test';
                  button.addEventListener('click', async () => {
                    await window.__sautaPaymentHandler({
                      paymentMethod: { id: 'pm_browser_ui' },
                      complete: (status) => { window.__sautaPaymentComplete = status; }
                    });
                  });
                  container.appendChild(button);
                }
              })
            }),
            confirmCardPayment: async () => ({
              paymentIntent: {
                id: 'mock_' + window.__sautaLastSessionId,
                status: 'succeeded'
              }
            })
          };
        };
      `,
    });
  });

  return { context, page, pageErrors };
}

describe('Browser UI full-stack — Chromium, Fastify e PostgreSQL reali', () => {
  let browser: Browser;
  let prisma: PrismaClient;
  let baseUrl: string;

  beforeAll(async () => {
    fs.mkdirSync(screenshotDir, { recursive: true });

    const setup = await setupE2eTest();
    prisma = setup.prisma;
    baseUrl = setup.baseUrl;

    await prisma.product.upsert({
      where: {
        venueId_slug: {
          venueId: 'venue_demo_1',
          slug: 'mojito-ui',
        },
      },
      update: {
        name: 'Mojito UI',
        price: 900,
        vatRate: 10,
        active: true,
      },
      create: {
        venueId: 'venue_demo_1',
        slug: 'mojito-ui',
        name: 'Mojito UI',
        price: 900,
        vatRate: 10,
        active: true,
      },
    });
    await prisma.product.upsert({
      where: {
        venueId_slug: {
          venueId: 'venue_demo_1',
          slug: 'analcolico-ui',
        },
      },
      update: {
        name: 'Analcolico UI',
        price: 600,
        vatRate: 10,
        active: true,
      },
      create: {
        venueId: 'venue_demo_1',
        slug: 'analcolico-ui',
        name: 'Analcolico UI',
        price: 600,
        vatRate: 10,
        active: true,
      },
    });

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
  }, 90000);

  afterAll(async () => {
    await browser?.close();
    await cleanupE2eTest();
  });

  it('completa da desktop menu → carrello → consenso → checkout attraverso le API reali Sauta', async () => {
    const { context, page, pageErrors } = await createBrowserContext(
      browser,
      { width: 1440, height: 1000 },
      true,
    );

    const apiRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) {
        apiRequests.push(request.url());
      }
    });

    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.locator('#menu-drinks-grid .product-card').first().waitFor();
    await page.locator('#browser-wallet-pay').waitFor();

    expect(await page.locator('.header-content h1').textContent())
      .toBe('Demo Sauta Cloud (A-Cube)');
    expect(await page.locator('#menu-drinks-grid .product-card').count()).toBe(2);
    expect(apiRequests.some((url) => new URL(url).pathname === '/api/venue/current')).toBe(true);
    expect(apiRequests.some((url) => new URL(url).pathname === '/api/venue/current/menu')).toBe(true);
    expect(apiRequests.every((url) => !new URL(url).searchParams.has('venueId'))).toBe(true);

    await page.screenshot({
      path: path.join(screenshotDir, 'desktop-menu.png'),
      fullPage: true,
    });

    const mojitoCard = page.locator('#menu-drinks-grid .product-card')
      .filter({ hasText: 'Mojito UI' });
    await mojitoCard.getByRole('button', { name: /Ordina/ }).click();

    await expect.poll(async () =>
      page.locator('#checkout-drawer').evaluate((element) =>
        element.classList.contains('visible')
      )
    ).toBe(true);
    expect(await page.locator('#cart-total').textContent()).toBe('€9.00');

    await page.locator('#compliance-consent').check();
    expect(await page.locator('#pay-btn').getAttribute('class')).not.toContain('disabled');

    await page.screenshot({
      path: path.join(screenshotDir, 'desktop-cart.png'),
      fullPage: false,
    });

    await page.locator('#browser-wallet-pay').click();
    await expect.poll(async () =>
      page.locator('#success-overlay').evaluate((element) =>
        !element.classList.contains('hidden')
      )
    ).toBe(true);

    expect(await page.evaluate(
      () => (window as Window & { __sautaPaymentComplete?: string }).__sautaPaymentComplete
    )).toBe('success');

    const wallet = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('sauta_wallet') || '[]')
    ) as Array<{ sessionId: string; token: string }>;
    expect(wallet).toHaveLength(1);
    expect(wallet[0].token).toMatch(/^swc_[a-f0-9]{64}$/);

    await expect.poll(async () => {
      const session = await prisma.checkoutSession.findUnique({
        where: { id: wallet[0].sessionId },
        include: { tickets: true },
      });
      return {
        status: session?.status,
        ticketStatus: session?.tickets[0]?.status,
        totalAmount: session?.totalAmount,
      };
    }).toEqual({
      status: 'paid',
      ticketStatus: 'valid',
      totalAmount: 900,
    });

    await page.screenshot({
      path: path.join(screenshotDir, 'desktop-success.png'),
      fullPage: false,
    });

    expect(pageErrors).toEqual([]);
    await context.close();
  });

  it('mantiene menu e carrello utilizzabili su viewport mobile senza overflow orizzontale', async () => {
    const { context, page, pageErrors } = await createBrowserContext(
      browser,
      { width: 390, height: 844 },
    );

    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.locator('#menu-drinks-grid .product-card').first().waitFor();

    const initialLayout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(initialLayout.documentWidth).toBeLessThanOrEqual(initialLayout.viewportWidth + 1);

    const cards = await page.locator('#menu-drinks-grid .product-card').evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
      })
    );
    for (const card of cards) {
      expect(card.left).toBeGreaterThanOrEqual(0);
      expect(card.right).toBeLessThanOrEqual(391);
    }

    const orderButton = page.locator('#menu-drinks-grid .product-card')
      .filter({ hasText: 'Mojito UI' })
      .getByRole('button', { name: /Ordina/ });
    const buttonBox = await orderButton.boundingBox();
    expect(buttonBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(buttonBox?.width ?? 0).toBeGreaterThanOrEqual(44);

    await page.screenshot({
      path: path.join(screenshotDir, 'mobile-menu.png'),
      fullPage: false,
    });

    const hiddenDrawerBox = await page.locator('#checkout-drawer').boundingBox();
    expect(hiddenDrawerBox).not.toBeNull();
    expect(hiddenDrawerBox!.y).toBeGreaterThanOrEqual(843);

    await orderButton.click();
    await expect.poll(async () =>
      page.locator('#checkout-drawer').evaluate((element) =>
        element.classList.contains('visible')
      )
    ).toBe(true);

    const drawerBox = await page.locator('#checkout-drawer').boundingBox();
    expect(drawerBox).not.toBeNull();
    expect(drawerBox!.x).toBeGreaterThanOrEqual(0);
    expect(drawerBox!.x + drawerBox!.width).toBeLessThanOrEqual(391);
    const quantityButtons = await page.locator('#checkout-drawer .btn-icon').all();
    for (const quantityButton of quantityButtons) {
      const quantityButtonBox = await quantityButton.boundingBox();
      expect(quantityButtonBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(quantityButtonBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expect.poll(async () => {
      const settledBox = await page.locator('#checkout-drawer').boundingBox();
      return Math.ceil((settledBox?.y ?? 0) + (settledBox?.height ?? 0));
    }).toBeLessThanOrEqual(845);

    const cartLayout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(cartLayout.documentWidth).toBeLessThanOrEqual(cartLayout.viewportWidth + 1);

    await page.screenshot({
      path: path.join(screenshotDir, 'mobile-cart.png'),
      fullPage: false,
    });

    expect(pageErrors).toEqual([]);
    await context.close();
  });
});
