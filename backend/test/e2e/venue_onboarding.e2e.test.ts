import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { setupE2eTest, cleanupE2eTest } from './e2e-helper';
import { createFakeIdentityProvider } from '../../src/utils/identityProvider';
import type { PrismaClient } from '@prisma/client';

describe('Wave 9C.0C — Venue Onboarding & Provisioning Real Chromium E2E Suite', () => {
  let browser: Browser;
  let page: Page;
  let consoleUrl: string;
  let venuePwaUrl: string;
  let fakeIdProvider: ReturnType<typeof createFakeIdentityProvider>;
  let prisma: PrismaClient;

  beforeAll(async () => {
    fakeIdProvider = createFakeIdentityProvider();
    const setup = await setupE2eTest({ identityProvider: fakeIdProvider });
    prisma = setup.prisma;
    const port = new URL(setup.baseUrl).port;
    consoleUrl = `http://console.localhost:${port}`;
    venuePwaUrl = `http://demo.localhost:${port}`;

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

  it('1. Platform Admin crea un nuovo draft venue con CSRF ed Idempotency-Key', async () => {
    // Seed Platform Admin
    const adminUser = await prisma.platformUser.create({
      data: {
        emailNormalized: 'admin-e2e@sauta.app',
        status: 'ACTIVE',
        platformRole: 'PLATFORM_ADMIN',
        workosUserId: 'wos_admin_e2e',
      },
    });

    const code = 'code_admin_e2e_login';
    fakeIdProvider.validCodes.set(code, {
      verifier: 'fake_code_verifier_12345678901234567890',
      user: {
        sessionId: 'sess_admin_e2e',
        userId: 'wos_admin_e2e',
        email: 'admin-e2e@sauta.app',
        emailVerified: true,
        organizationId: undefined,
      },
    });

    // Login Platform Admin
    await page.goto(`${consoleUrl}/console`, { waitUntil: 'load' });
    await page.click('#btn-login-authkit');
    await page.waitForURL('http://authkit.workos.fake/**');
    const state = new URL(page.url()).searchParams.get('state');

    await page.goto(`${consoleUrl}/api/auth/callback?code=${code}&state=${state}`, {
      waitUntil: 'load',
    });
    await page.locator('#dashboard-section').waitFor({ state: 'visible' });

    await page.locator('#platform-onboarding-section').waitFor({
      state: 'visible',
    });
    await page.fill('#platform-venue-name', 'Venue E2E Onboarding');
    await page.fill('#platform-venue-slug', 'venue-e2e-onboarding');
    await page.fill('#platform-owner-email', 'owner-e2e@sauta.app');
    const createResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/platform/venues') &&
        response.request().method() === 'POST'
    );
    await page.click('#btn-create-platform-venue');
    expect((await createResponse).status()).toBe(201);
    expect(
      await page.locator('#platform-create-message').textContent()
    ).toContain('Draft creato');
    await page.waitForFunction(() =>
      document
        .getElementById('platform-onboarding-summary')
        ?.textContent?.includes('Venue E2E Onboarding')
    );
    expect(
      await page.locator('#platform-onboarding-summary').textContent()
    ).toContain('Venue E2E Onboarding');
    expect(
      await page.locator('#platform-onboarding-steps').textContent()
    ).toContain('STRIPE');
  });

  it('2. OWNER riceve invito e completa callback su venue inattiva in onboarding', async () => {
    // Trova la venue creata
    const venue = await prisma.venue.findFirst({
      where: { name: 'Venue E2E Onboarding' },
    });
    expect(venue).toBeTruthy();
    expect(venue?.isActive).toBe(false);

    // Trova la membership pending e l'invitation pending
    const invitation = await prisma.venueInvitation.findFirst({
      where: { venueId: venue!.id, invitedEmailNormalized: 'owner-e2e@sauta.app' },
    });
    expect(invitation).toBeTruthy();
    expect(['PENDING', 'SENT']).toContain(invitation?.status);

    // Simula login OWNER via AuthKit callback
    const ownerCode = 'code_owner_e2e_login';
    fakeIdProvider.validCodes.set(ownerCode, {
      verifier: 'fake_code_verifier_12345678901234567890',
      user: {
        sessionId: 'sess_owner_e2e',
        userId: 'wos_usr_owner_e2e',
        email: 'owner-e2e@sauta.app',
        emailVerified: true,
        organizationId: venue!.workosOrganizationId!,
      },
    });

    // Pulisci cookie sessione admin
    await page.context().clearCookies();
    await page.goto(`${consoleUrl}/console`, { waitUntil: 'load' });
    await page.click('#btn-login-authkit');
    await page.waitForURL('http://authkit.workos.fake/**');
    const ownerState = new URL(page.url()).searchParams.get('state');

    await page.goto(`${consoleUrl}/api/auth/callback?code=${ownerCode}&state=${ownerState}`, {
      waitUntil: 'load',
    });

    await page.locator('#dashboard-section').waitFor({ state: 'visible' });
    await page.locator('#owner-onboarding-section').waitFor({
      state: 'visible',
    });
    expect(
      await page.locator('#owner-onboarding-summary').textContent()
    ).toContain('Venue E2E Onboarding');

    // Verifica che l'invito sia ora ACCEPTED e membership ACTIVE
    const updatedInvitation = await prisma.venueInvitation.findUnique({
      where: { id: invitation!.id },
    });
    expect(updatedInvitation?.status).toBe('ACCEPTED');

    const updatedMembership = await prisma.venueMembership.findFirst({
      where: { venueId: venue!.id, role: 'OWNER' },
    });
    expect(updatedMembership?.status).toBe('ACTIVE');

    // Verifica risposta /api/console/me per l'owner
    const meRes = await page.evaluate(async () => {
      const res = await fetch('/api/console/me');
      return await res.json();
    });

    expect(meRes.onboardingVenues.length).toBe(1);
    expect(meRes.onboardingVenues[0].venueId).toBe(venue!.id);
  });

  it('3. OWNER aggiorna profilo legale e tenta attivazione (fail-closed remediation)', async () => {
    const venue = await prisma.venue.findFirst({
      where: { name: 'Venue E2E Onboarding' },
    });

    await page.fill(
      '#owner-profile-name',
      'Venue E2E Onboarding Aggiornata'
    );
    await page.fill('#owner-profile-vat', 'IT12345678901');
    await page.fill('#owner-profile-address', 'Via Roma 100');
    await page.fill('#owner-profile-city', 'Milano');
    await page.fill('#owner-profile-zip', '20121');
    const profileResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/console/onboarding/profile') &&
        response.request().method() === 'PATCH'
    );
    await page.click('#btn-save-owner-profile');
    expect((await profileResponse).status()).toBe(200);
    expect(
      await page.locator('#owner-profile-message').textContent()
    ).toContain('Profilo aggiornato');

    // Ora simula Admin login per eseguire la review e tentare attivazione
    const adminUser = await prisma.platformUser.findUnique({
      where: { emailNormalized: 'admin-e2e@sauta.app' },
    });

    const adminCode = 'code_admin_activate_attempt';
    fakeIdProvider.validCodes.set(adminCode, {
      verifier: 'fake_code_verifier_12345678901234567890',
      user: {
        sessionId: 'sess_admin_activate',
        userId: adminUser!.workosUserId!,
        email: adminUser!.emailNormalized,
        emailVerified: true,
        organizationId: undefined,
      },
    });

    await page.context().clearCookies();
    await page.goto(`${consoleUrl}/console`, { waitUntil: 'load' });
    await page.click('#btn-login-authkit');
    await page.waitForURL('http://authkit.workos.fake/**');
    const state = new URL(page.url()).searchParams.get('state');

    await page.goto(`${consoleUrl}/api/auth/callback?code=${adminCode}&state=${state}`, {
      waitUntil: 'load',
    });
    await page.locator('#platform-onboarding-section').waitFor({
      state: 'visible',
    });
    await page.selectOption('#platform-venue-select', venue!.id);
    await page.click('#btn-load-platform-venue');
    for (const selector of ['#btn-review-legal', '#btn-review-operations']) {
      const reviewResponse = page.waitForResponse(
        (response) =>
          response.url().includes('/onboarding/review') &&
          response.request().method() === 'PATCH'
      );
      await page.click(selector);
      expect((await reviewResponse).status()).toBe(200);
    }

    const activateResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/platform/venues/${venue!.id}/activate`) &&
        response.request().method() === 'POST'
    );
    await page.click('#btn-attempt-activation');
    const activateHttpResponse = await activateResponse;
    const activateBody = await activateHttpResponse.json();

    // Attivazione fallisce con 400 ed elenca i reason code mancanti (STRIPE & FISCAL non pronti)
    expect(activateHttpResponse.status()).toBe(400);
    expect(activateBody.reasonCode).toBe('activation_denied');
    expect(activateBody.missingSteps).toContain('STRIPE');
    expect(activateBody.missingSteps).toContain('FISCAL');

    // La venue resta inattiva
    const refreshedVenue = await prisma.venue.findUnique({
      where: { id: venue!.id },
    });
    expect(refreshedVenue?.isActive).toBe(false);
  });

  it('4. Isolamento cookie ed origin: sessione console non filtra su host tenant PWA', async () => {
    // Accedi all'host PWA venue (demo.localhost)
    await page.goto(venuePwaUrl, { waitUntil: 'load' });

    // Verifica che i cookie console (__Host-wos_session) non siano leggibili dal codice client PWA
    const cookies = await page.context().cookies(venuePwaUrl);
    const consoleCookiesOnPwa = cookies.filter((c) => c.name.includes('wos_session'));

    // I cookie __Host- sono host-only per console.localhost e non compaiono su demo.localhost
    expect(consoleCookiesOnPwa.length).toBe(0);
  });
});
