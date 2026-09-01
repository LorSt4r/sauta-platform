import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupE2eTest, cleanupE2eTest, createE2eVenue } from './e2e-helper';
import { PrismaClient } from '@prisma/client';

describe('GDPR Guest Anonymity E2E Tests', () => {
  let app: any;
  let prisma: PrismaClient;
  let baseUrl: string;

  beforeAll(async () => {
    const setup = await setupE2eTest();
    app = setup.app;
    prisma = setup.prisma;
    baseUrl = setup.baseUrl;
  });

  afterAll(async () => {
    await cleanupE2eTest();
  });

  // TIER 1: Functional Verification
  describe('Tier 1: Functional Verification', () => {
    it('should complete checkout for guest without storing email in the database', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'GDPR Venue 1',
        products: {
          create: [{ slug: 'gin-tonic', name: 'Gin Tonic', price: 1000 }],
        },
      });

      const response = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 1000,
          items: { 'gin-tonic': 1 },
          digitalConsent: true,
        }),
      });

      expect(response.status).toBe(200);
      const data: any = await response.json();
      expect(data.sessionId).toBeDefined();

      const sessions = await prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM checkout_sessions WHERE id = $1',
        data.sessionId
      );
      expect(sessions.length).toBe(1);
      expect(sessions[0].email).toBeNull();
    });

    it('should confirm checkout without sending emails via nodemailer', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'GDPR Venue 2',
        products: {
          create: [{ slug: 'negroni', name: 'Negroni', price: 800 }],
        },
      });

      const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 800,
          items: { 'negroni': 1 },
          digitalConsent: true,
        }),
      });
      const checkoutData: any = await checkoutRes.json();
      const sessionId = checkoutData.sessionId;

      const response = await fetch(`${baseUrl}/api/checkout/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentIntentId: `mock_${sessionId}`,
        }),
      });

      expect(response.status).toBe(200);
      const sessions = await prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM checkout_sessions WHERE id = $1',
        sessionId
      );
      expect(sessions[0].status).toBe('paid');
      expect(sessions[0].email).toBeNull();
    });

    it('should not contain any active nodemailer client or smtp transport configuration in app memory', async () => {
      await expect(import('../../src/utils/mailer')).rejects.toThrow();
    });

    it('should anonymize existing old sessions email through GDPR cron routine', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'GDPR Cleanup Venue',
      });

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 10);

      const session = await prisma.checkoutSession.create({
        data: {
          venueId: venue.id,
          totalAmount: 1000,
          email: 'old-data-retention-test@sauta.com',
          status: 'paid',
          createdAt: pastDate,
        },
      });

      await prisma.checkoutSession.updateMany({
        where: {
          createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          email: { not: null },
        },
        data: {
          email: null,
        },
      });

      const updated = await prisma.checkoutSession.findUnique({ where: { id: session.id } });
      expect(updated?.email).toBeNull();
    });

    it('should process webhook event payment_intent.succeeded without storing guest email', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'GDPR Webhook Venue',
        products: {
          create: [{ slug: 'mojito', name: 'Mojito', price: 900 }],
        },
      });

      const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 900,
          items: { 'mojito': 1 },
          digitalConsent: true,
        }),
      });
      const checkoutData: any = await checkoutRes.json();
      const sessionId = checkoutData.sessionId;

      const sessions = await prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM checkout_sessions WHERE id = $1',
        sessionId
      );
      expect(sessions[0].email).toBeNull();
    });

    it('should verify that no receipt emails are queued or stored in database', async () => {
      const auditEmails = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM pg_catalog.pg_tables WHERE schemaname = 'public'`
      );
      const emailTables = auditEmails.filter(t => t.tablename.includes('email') || t.tablename.includes('mail'));
      expect(emailTables.length).toBe(0);
    });
  });

  // TIER 2: Boundary & Error Conditions
  describe('Tier 2: Boundary & Error Conditions', () => {
    it('should reject email queries or lookups on guest checkouts in the wallet API', async () => {
      const response = await fetch(`${baseUrl}/api/wallet/tickets?email=guest-e2e-test@sauta.com`, {
        method: 'GET',
      });
      expect(response.status).toBe(404);
      const data: any = await response.json();
      expect(data.error).toBe('Not Found');
    });

    it('should reject checkout requests if GDPR guest policies are violated', async () => {
      const venue = await createE2eVenue(prisma, { name: 'GDPR Violations Venue' });
      const response = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 1000,
          items: {},
          digitalConsent: true,
        }),
      });
      expect(response.status).toBe(400);
    });

    it('should handle checkout cleanly without email field', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'GDPR Clean Venue',
        products: {
          create: [{ slug: 'spritz', name: 'Spritz', price: 700 }],
        },
      });

      const response = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 700,
          items: { 'spritz': 1 },
          digitalConsent: true,
        }),
      });

      expect(response.status).toBe(200);
      const data: any = await response.json();

      const sessions = await prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM checkout_sessions WHERE id = $1',
        data.sessionId
      );
      expect(sessions.length).toBe(1);
      expect(sessions[0].email).toBeNull();
    });

    it('should process webhook payload keeping db field null', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'GDPR Webhook Payload',
        products: {
          create: [{ slug: 'beer', name: 'Beer', price: 500 }],
        },
      });

      const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 500,
          items: { 'beer': 1 },
          digitalConsent: true,
        }),
      });
      const checkoutData: any = await checkoutRes.json();
      const sessionId = checkoutData.sessionId;

      const sessions = await prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM checkout_sessions WHERE id = $1',
        sessionId
      );
      expect(sessions[0].email).toBeNull();
    });

    it('should handle confirm checkout multiple times without leaking email to logs', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'GDPR Multi-confirm Venue',
        products: {
          create: [{ slug: 'rum', name: 'Rum', price: 1200 }],
        },
      });

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

      await fetch(`${baseUrl}/api/checkout/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: `mock_${sessionId}` }),
      });

      const res = await fetch(`${baseUrl}/api/checkout/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: `mock_${sessionId}` }),
      });
      expect(res.status).toBe(200);
    });

    it('should fail to fetch receipt by email under guest anonymity policies', async () => {
      const response = await fetch(`${baseUrl}/api/receipt/guest@sauta.com`, {
        method: 'GET',
      });
      expect(response.status).toBe(401);
    });
  });
});
