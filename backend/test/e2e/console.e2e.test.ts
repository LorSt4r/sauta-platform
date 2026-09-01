import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { setupE2eTest, cleanupE2eTest } from './e2e-helper';
import { createFakeIdentityProvider } from '../../src/utils/identityProvider';
import type { PrismaClient } from '@prisma/client';

describe('Wave 9C.0B — Sauta Console Real Chromium E2E Suite', () => {
  let browser: Browser;
  let page: Page;
  let consoleUrl: string;
  let fakeIdProvider: ReturnType<typeof createFakeIdentityProvider>;
  let prisma: PrismaClient;

  beforeAll(async () => {
    fakeIdProvider = createFakeIdentityProvider();
    const setup = await setupE2eTest({ identityProvider: fakeIdProvider });
    prisma = setup.prisma;
    const port = new URL(setup.baseUrl).port;
    consoleUrl = `http://console.localhost:${port}`;

    // Host-rules mappa *.localhost su 127.0.0.1 e authkit.workos.fake sulla porta del server di test
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        `--host-rules=MAP *.localhost 127.0.0.1, MAP authkit.workos.fake 127.0.0.1:${port}`,
      ],
    });
    page = await browser.newPage();

    // Mock della pagina esterna AuthKit
    await page.route('**/authkit.workos.fake/**', (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1 id="authkit-fake">AuthKit Fake Provider</h1></body></html>',
      });
    });
  }, 90000);

  afterAll(async () => {
    await browser?.close();
    await cleanupE2eTest();
  });

  it('1. console.localhost mostra UI login e non esegue fetch PWA tenant (/api/venue/current)', async () => {
    let pwaFetchCalled = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/venue/current')) {
        pwaFetchCalled = true;
      }
    });

    await page.goto(`${consoleUrl}/console`, { waitUntil: 'load' });
    await page.locator('#login-section').waitFor({ state: 'visible' });

    expect(await page.locator('#login-section h2').textContent()).toBe('Accesso Console');
    expect(await page.locator('#console-status-badge').textContent()).toBe('Non Autenticato');
    expect(pwaFetchCalled).toBe(false);
  });

  it('2. login PKCE/callback mostra soltanto la venue autorizzata e nega switch cross-tenant', async () => {
    // 1. Pre-provisioning venue e utente invitato con membership PENDING
    const venue1 = await prisma.venue.upsert({
      where: { id: 'venue_e2e_console_1' },
      update: { name: 'E2E Venue Console Alpha', workosOrganizationId: 'org_console_e2e_alpha', isActive: true },
      create: { id: 'venue_e2e_console_1', name: 'E2E Venue Console Alpha', workosOrganizationId: 'org_console_e2e_alpha', isActive: true },
    });

    const venue2 = await prisma.venue.upsert({
      where: { id: 'venue_e2e_console_2' },
      update: { name: 'E2E Venue Console Beta', workosOrganizationId: 'org_console_e2e_beta', isActive: true },
      create: { id: 'venue_e2e_console_2', name: 'E2E Venue Console Beta', workosOrganizationId: 'org_console_e2e_beta', isActive: true },
    });

    const userEmail = 'e2e-owner@sauta.app';
    const invitedUser = await prisma.platformUser.create({
      data: {
        emailNormalized: userEmail,
        status: 'INVITED',
        platformRole: 'NONE',
        workosUserId: null,
      },
    });

    await prisma.venueMembership.create({
      data: {
        userId: invitedUser.id,
        venueId: venue1.id,
        role: 'OWNER',
        status: 'PENDING',
      },
    });

    // 2. Configura il codice e l'utente nel Fake Identity Provider
    const code = 'e2e_valid_code_999';
    fakeIdProvider.validCodes.set(code, {
      verifier: 'fake_code_verifier_12345678901234567890',
      user: {
        sessionId: 'sess_e2e_authkit',
        userId: 'wos_usr_e2e_authkit',
        email: userEmail,
        emailVerified: true,
        organizationId: 'org_console_e2e_alpha',
      },
    });

    // Il click attraversa davvero la route login e il redirect Hosted UI fake.
    await page.click('#btn-login-authkit');
    await page.waitForURL('http://authkit.workos.fake/**');

    // L'URL reindirizzato conterrà state
    const currentUrl = page.url();
    expect(currentUrl).toContain('http://authkit.workos.fake/auth');
    const urlObj = new URL(currentUrl);
    const stateParam = urlObj.searchParams.get('state');
    expect(stateParam).toBeTruthy();

    // 4. Simula il callback AuthKit con il codice e lo stato generati
    await page.goto(`${consoleUrl}/api/auth/callback?code=${code}&state=${stateParam}`, { waitUntil: 'load' });

    // Reindirizzato a /console in stato autenticato
    await page.locator('#dashboard-section').waitFor({ state: 'visible' });
    await page.waitForFunction(
      () =>
        document.getElementById('current-venue-name')?.textContent ===
        'E2E Venue Console Alpha'
    );

    expect(await page.locator('#console-status-badge').textContent()).toBe('Autenticato');
    expect(await page.locator('#user-email-heading').textContent()).toBe(userEmail);
    expect(await page.locator('#current-venue-name').textContent()).toBe('E2E Venue Console Alpha');
    expect(await page.locator('#user-platform-role').textContent()).toContain('NONE');
    expect(await page.locator('#current-venue-role').textContent()).toBe('Ruolo Venue: OWNER');

    const venueSelect = page.locator('#venue-select');
    expect(await venueSelect.locator('option').count()).toBe(1);
    expect(await venueSelect.inputValue()).toBe('org_console_e2e_alpha');

    const crossTenantResult = await page.evaluate(async (organizationId) => {
      const csrfResponse = await fetch('/api/auth/csrf');
      const { csrfToken } = await csrfResponse.json();
      const response = await fetch('/api/auth/switch-organization', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ organizationId }),
      });
      return {
        status: response.status,
        reasonCode: (await response.json()).reasonCode,
      };
    }, venue2.workosOrganizationId);
    expect(crossTenantResult).toEqual({
      status: 403,
      reasonCode: 'membership_inactive',
    });
    expect(await page.locator('#current-venue-name').textContent()).toBe(
      'E2E Venue Console Alpha'
    );

    // La chiamata manuale sopra ha ruotato il cookie CSRF. Il reload fa
    // acquisire al modulo frontend il token corrispondente prima del logout.
    await page.reload({ waitUntil: 'load' });
    await page.locator('#dashboard-section').waitFor({ state: 'visible' });
  });

  it('3. logout CSRF cancella la sessione locale e attraversa il logout remoto fake', async () => {
    const logoutResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/auth/logout') &&
        response.request().method() === 'POST'
    );
    await page.click('#btn-logout-console');
    const logoutResponse = await logoutResponsePromise;
    expect(logoutResponse.status()).toBe(200);
    await page.waitForURL((url) => url.searchParams.get('logged_out') === 'true');

    await page.locator('#login-section').waitFor({ state: 'visible' });
    expect(await page.locator('#console-status-badge').textContent()).toBe('Non Autenticato');
    expect(fakeIdProvider.logoutRequests).toEqual([
      {
        sessionId: 'sess_e2e_authkit',
        postLogoutRedirectUri: consoleUrl,
      },
    ]);
  });

  it('4. sessione scaduta torna a UX neutra senza esporre dettagli provider', async () => {
    const code = 'e2e_expired_code';
    fakeIdProvider.validCodes.set(code, {
      verifier: 'fake_code_verifier_12345678901234567890',
      user: {
        sessionId: 'sess_e2e_expired',
        userId: 'wos_usr_e2e_authkit',
        email: 'e2e-owner@sauta.app',
        emailVerified: true,
        organizationId: 'org_console_e2e_alpha',
      },
    });

    await page.click('#btn-login-authkit');
    await page.waitForURL('http://authkit.workos.fake/**');
    const state = new URL(page.url()).searchParams.get('state');
    expect(state).toBeTruthy();
    await page.goto(`${consoleUrl}/api/auth/callback?code=${code}&state=${state}`, {
      waitUntil: 'load',
    });
    await page.locator('#dashboard-section').waitFor({ state: 'visible' });

    fakeIdProvider.sessions.clear();
    await page.reload({ waitUntil: 'load' });
    await page.locator('#login-section').waitFor({ state: 'visible' });
    expect(await page.locator('#console-status-badge').textContent()).toBe(
      'Non Autenticato'
    );
    expect(await page.locator('body').textContent()).not.toContain('session_expired');
    expect(await page.locator('body').textContent()).not.toContain('WorkOS API');
  });

  it('5. desktop/mobile non hanno overflow, focus è visibile e target sono 44x44', async () => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 375, height: 667 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`${consoleUrl}/console`, { waitUntil: 'load' });

      const dimensions = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
    }

    const loginButton = page.locator('#btn-login-authkit');
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      'btn-login-authkit'
    );
    const accessibility = await loginButton.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        width: rect.width,
        height: rect.height,
      };
    });
    expect(accessibility.outlineStyle).not.toBe('none');
    expect(accessibility.outlineWidth).toBeGreaterThanOrEqual(3);
    expect(accessibility.width).toBeGreaterThanOrEqual(44);
    expect(accessibility.height).toBeGreaterThanOrEqual(44);
  });
});
