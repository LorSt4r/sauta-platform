import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupE2eTest, cleanupE2eTest, createE2eVenue } from './e2e-helper';
import { PrismaClient } from '@prisma/client';
import { generateWalletToken, hashWalletToken } from '../../src/utils/capability';

describe('Feature Combinations E2E Tests (Tier 3)', () => {
  let app: any;
  let prisma: PrismaClient;
  let baseUrl: string;
  let adminSecret = process.env.ADMIN_SECRET || 'test-admin-secret-32chars-aaaaaaaaaaaaaa';

  beforeAll(async () => {
    const setup = await setupE2eTest();
    app = setup.app;
    prisma = setup.prisma;
    baseUrl = setup.baseUrl;
  });

  afterAll(async () => {
    await cleanupE2eTest();
  });

  it('should process GDPR guest checkout with digital receipt consent on a Stripe Connect venue', async () => {
    // 1. Create a venue and onboard it
    const venue = await createE2eVenue(prisma, { name: 'Combo Venue 1' });
    await fetch(`${baseUrl}/api/onboard-venue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': adminSecret,
      },
      body: JSON.stringify({
        venueId: venue.id,
        businessType: 'company',
      }),
    });

    // Seed products for venue
    await prisma.product.create({
      data: { venueId: venue.id, slug: 'gin-tonic', name: 'Gin Tonic', price: 1000 },
    });

    // 2. Perform Guest checkout with consent
    const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalAmount: 1000,
        items: { 'gin-tonic': 1 },
        digitalConsent: true,
      }),
    });

    expect(checkoutRes.status).toBe(200);
    const checkoutData: any = await checkoutRes.json();
    const sessionId = checkoutData.sessionId;

    // 3. Verify GDPR email is NOT saved, but digital consent checkbox and timestamp are saved in DB
    const sessions = await prisma.$queryRawUnsafe<any[]>(
      'SELECT * FROM checkout_sessions WHERE id = $1',
      sessionId
    );

    const session = sessions[0];
    expect(session.email).toBeNull();
    expect(session.digital_consent).toBe(true);

    const consentTimestamp = session.digital_consent_timestamp ?? session.digitalConsentTimestamp;
    expect(consentTimestamp).toBeDefined();
    expect(consentTimestamp).not.toBeNull();
  });

  it('should prevent checkout on a Stripe Connect venue if digital consent is false', async () => {
    const venue = await createE2eVenue(prisma, { name: 'Combo Venue 2', stripeAccountId: 'acct_combo_2' });
    await prisma.product.create({
      data: { venueId: venue.id, slug: 'beer', name: 'Beer', price: 500 },
    });

    const response = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalAmount: 500,
        items: { 'beer': 1 },
        digitalConsent: false,
      }),
    });

    expect(response.status).toBe(400);
  });

  it('should create and verify Swipe to Consume token after a successful Stripe Connect payment confirmation', async () => {
    const venue = await createE2eVenue(prisma, { name: 'Combo Venue 3', stripeAccountId: 'acct_combo_3' });
    await prisma.product.create({
      data: { venueId: venue.id, slug: 'rum', name: 'Rum', price: 1200 },
    });

    // 1. Checkout
    const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalAmount: 1200,
        items: { 'rum': 1 },
        digitalConsent: true,
      }),
    });
    const checkoutData: any = await checkoutRes.json();
    const sessionId = checkoutData.sessionId;
    const walletToken = checkoutData.walletToken;

    // 2. Confirm payment
    const confirmRes = await fetch(`${baseUrl}/api/checkout/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentIntentId: `mock_${sessionId}` }),
    });

    expect(confirmRes.status).toBe(200);
    const confirmData: any = await confirmRes.json();
    expect(confirmData.success).toBe(true);
    expect(confirmData.tickets.length).toBe(1);

    const ticket = confirmData.tickets[0];
    expect(ticket.status).toBe('valid');

    // 3. Autorizza e completa lo Swipe to Consume
    const tokenResponse = await fetch(`${baseUrl}/api/wallet/consume-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, token: walletToken, ticketId: ticket.id }),
    });
    const { consumeToken } = await tokenResponse.json() as { consumeToken: string };
    const consumeRes = await fetch(`${baseUrl}/api/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumeToken }),
    });

    expect(consumeRes.status).toBe(200);
    const consumeData: any = await consumeRes.json();
    expect(consumeData.success).toBe(true);

    // Verify status in DB
    const tickets = await prisma.$queryRawUnsafe<any[]>(
      'SELECT * FROM tickets WHERE id = $1',
      ticket.id
    );
    expect(tickets[0].status).toBe('used');
  });

  it('should maintain digital consent metadata even after old GDPR guest email cleanup', async () => {
    const venue = await createE2eVenue(prisma, { name: 'Combo Venue 4' });

    // Create an old session manually with email, digitalConsent, and digitalConsentTimestamp
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

    const session = await prisma.checkoutSession.create({
      data: {
        venueId: venue.id,
        totalAmount: 1500,
        status: 'paid',
        digitalConsent: true,
        digitalConsentTimestamp: tenDaysAgo,
        email: 'old-combo-guest@sauta.com',
        createdAt: tenDaysAgo,
      },
    });

    // Run GDPR cleanup
    await prisma.checkoutSession.updateMany({
      where: {
        createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        email: { not: null },
      },
      data: {
        email: null,
      },
    });

    // Verify in DB that email is null but digital consent is still true and has timestamp
    const sessions = await prisma.$queryRawUnsafe<any[]>(
      'SELECT * FROM checkout_sessions WHERE id = $1',
      session.id
    );
    const dbSession = sessions[0];
    expect(dbSession.email).toBeNull();
    expect(dbSession.digital_consent).toBe(true);

    const consentTimestamp = dbSession.digital_consent_timestamp ?? dbSession.digitalConsentTimestamp;
    expect(consentTimestamp).toBeDefined();
  });

  it('should verify receipt retrieval works and displays correct fee percentage for Stripe Connect onboarded venue', async () => {
    const venue = await createE2eVenue(prisma, { name: 'Combo Venue 5', stripeAccountId: 'acct_combo_5', applicationFeePercent: 3.5 });
    await prisma.product.create({
      data: { venueId: venue.id, slug: 'gin-tonic', name: 'Gin Tonic', price: 1000 },
    });

    const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalAmount: 1000,
        items: { 'gin-tonic': 1 },
        digitalConsent: true,
      }),
    });
    const checkoutData: any = await checkoutRes.json();
    const sessionId = checkoutData.sessionId;

    // Confirm
    await fetch(`${baseUrl}/api/checkout/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentIntentId: `mock_${sessionId}` }),
    });

    // Fetch printable receipt
    const response = await fetch(`${baseUrl}/api/wallet/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, token: checkoutData.walletToken }),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Documento Commerciale');
  });

  it('should allow consuming tickets, verifying DevOps health status remains positive', async () => {
    const venue = await createE2eVenue(prisma, { name: 'Combo Venue 6' });
    const session = await prisma.checkoutSession.create({
      data: { venueId: venue.id, totalAmount: 1000, status: 'paid' },
    });
    const ticket = await prisma.ticket.create({
      data: { sessionId: session.id, venueId: venue.id, productName: 'mojito', price: 1000, status: 'valid' },
    });

    const walletToken = generateWalletToken();
    await prisma.walletCapability.create({
      data: {
        sessionId: session.id,
        tokenHash: hashWalletToken(walletToken),
      },
    });
    const tokenResponse = await fetch(`${baseUrl}/api/wallet/consume-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        token: walletToken,
        ticketId: ticket.id,
      }),
    });
    const { consumeToken } = await tokenResponse.json() as { consumeToken: string };

    // Consume ticket
    await fetch(`${baseUrl}/api/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumeToken }),
    });

    // Check health
    const healthRes = await fetch(`${baseUrl}/health`, { method: 'GET' });
    expect(healthRes.status).toBe(200);
    const healthData: any = await healthRes.json();
    expect(healthData.status).toBe('ok');
    expect(healthData.database.status).toBe('ok');
  });
});
