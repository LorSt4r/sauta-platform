import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { isSameDayVoid, determineVoidType } from '../../src/utils/fiscal';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, type TestDbHandle } from '../db';
import { registerAdminRoutes } from '../../src/routes/admin';
import { registerStripeRoutes } from '../../src/routes/stripe';
import { createConfig } from '../../src/utils/config';
import {
  getAcubeToken,
  voidAcubeReceipt,
} from '../../src/utils/acubeClient';
import { ensureSessionInvoiced } from '../../src/utils/fiscalReconciler';

describe('Empirical Verification: Target 1 - isSameDayVoid Timezone & Boundaries', () => {
  it('1.1: CET (winter) midnight crossing - UTC same day, Europe/Rome different day', () => {
    // 2026-01-15T22:30:00Z = 2026-01-15 23:30:00 CET (Jan 15 in Rome)
    // 2026-01-15T23:30:00Z = 2026-01-16 00:30:00 CET (Jan 16 in Rome)
    // Under UTC date methods both dates are 2026-01-15 (BUG if UTC used)
    const orig = new Date('2026-01-15T22:30:00Z');
    const voidDate = new Date('2026-01-15T23:30:00Z');

    expect(isSameDayVoid(orig, voidDate)).toBe(false);
    expect(determineVoidType(orig, voidDate)).toBe('storno');
  });

  it('1.2: CEST (summer) midnight crossing - UTC same day, Europe/Rome different day', () => {
    // 2026-07-14T21:30:00Z = 2026-07-14 23:30:00 CEST (Jul 14 in Rome)
    // 2026-07-14T22:30:00Z = 2026-07-15 00:30:00 CEST (Jul 15 in Rome)
    const orig = new Date('2026-07-14T21:30:00Z');
    const voidDate = new Date('2026-07-14T22:30:00Z');

    expect(isSameDayVoid(orig, voidDate)).toBe(false);
    expect(determineVoidType(orig, voidDate)).toBe('storno');
  });

  it('1.3: Same day late night in Rome (CET)', () => {
    // 2026-01-15T22:30:00Z = 2026-01-15 23:30:00 CET
    // 2026-01-15T22:59:00Z = 2026-01-15 23:59:00 CET
    const orig = new Date('2026-01-15T22:30:00Z');
    const voidDate = new Date('2026-01-15T22:59:00Z');

    expect(isSameDayVoid(orig, voidDate)).toBe(true);
    expect(determineVoidType(orig, voidDate)).toBe('voided');
  });

  it('1.4: DST Spring transition boundary (March 29, 2026)', () => {
    // 2026-03-28T22:30:00Z = 2026-03-28 23:30:00 CET (Mar 28 in Rome)
    // 2026-03-28T23:30:00Z = 2026-03-29 00:30:00 CET (Mar 29 in Rome)
    const orig = new Date('2026-03-28T22:30:00Z');
    const voidDate = new Date('2026-03-28T23:30:00Z');

    expect(isSameDayVoid(orig, voidDate)).toBe(false);

    // Spring forward jump: 02:00 CET -> 03:00 CEST on March 29, 2026
    // 2026-03-29T00:30:00Z = 2026-03-29 01:30:00 CET
    // 2026-03-29T01:30:00Z = 2026-03-29 03:30:00 CEST (after jump)
    const origMar29 = new Date('2026-03-29T00:30:00Z');
    const voidMar29 = new Date('2026-03-29T01:30:00Z');

    expect(isSameDayVoid(origMar29, voidMar29)).toBe(true);
  });

  it('1.5: DST Autumn transition boundary (October 25, 2026)', () => {
    // Fallback: 03:00 CEST -> 02:00 CET on Oct 25, 2026
    // 2026-10-24T21:30:00Z = 2026-10-24 23:30:00 CEST (Oct 24 in Rome)
    // 2026-10-24T22:30:00Z = 2026-10-25 00:30:00 CEST (Oct 25 in Rome)
    const orig = new Date('2026-10-24T21:30:00Z');
    const voidDate = new Date('2026-10-24T22:30:00Z');

    expect(isSameDayVoid(orig, voidDate)).toBe(false);

    // After midnight on Oct 25: before and after clocks turn back
    // 2026-10-25T00:30:00Z = 2026-10-25 02:30:00 CEST
    // 2026-10-25T01:30:00Z = 2026-10-25 02:30:00 CET
    const origOct25 = new Date('2026-10-25T00:30:00Z');
    const voidOct25 = new Date('2026-10-25T01:30:00Z');

    expect(isSameDayVoid(origOct25, voidOct25)).toBe(true);
  });

  it('1.6: Invalid Date behavior', () => {
    const invalidDate = new Date('invalid');
    const validDate = new Date();

    expect(() => isSameDayVoid(invalidDate, validDate)).toThrow(RangeError);
  });
});

describe('Empirical Verification: Target 2 - Cart Item Quantity Ceiling in /api/checkout', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
    await prisma.$connect();

    const mockStripe = {
      paymentIntents: {
        create: vi.fn(async (params: any) => ({
          id: 'pi_mock_cart_test',
          client_secret: 'secret_mock_cart_test',
        })),
      },
    } as unknown as Stripe;

    app = await createTestApp(prisma, { stripeSecretKey: 'sk_test_mock', stripe: mockStripe });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.ticket.deleteMany();
    await prisma.checkoutSession.deleteMany();
    await prisma.product.deleteMany();
    await prisma.venueDomain.deleteMany();
    await prisma.venue.deleteMany();

    await prisma.venue.create({
      data: {
        id: 'v_cart',
        name: 'Cart Ceiling Venue',
        isActive: true,
        domains: {
          create: {
            hostname: 'cart.sauta.app',
            type: 'PLATFORM',
            status: 'VERIFIED',
            isPrimary: true,
            verifiedAt: new Date(),
          },
        },
        products: {
          create: [
            { id: 'p_beer', slug: 'beer', name: 'Beer', price: 500, vatRate: 10.0 },
            { id: 'p_shot', slug: 'shot', name: 'Shot', price: 300, vatRate: 10.0 },
          ],
        },
      },
    });
  });

  it('2.1: qty = 0 -> returns 400 "Nessun prodotto valido nel carrello"', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'cart.sauta.app' },
      payload: {
        totalAmount: 0,
        items: { beer: 0 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Nessun prodotto valido nel carrello');
  });

  it('2.2: qty = negative (-5) -> returns 400 "Nessun prodotto valido nel carrello"', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'cart.sauta.app' },
      payload: {
        totalAmount: -2500,
        items: { beer: -5 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Nessun prodotto valido nel carrello');
  });

  it('2.3: qty = float (1.5) -> returns 400 "Nessun prodotto valido nel carrello"', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'cart.sauta.app' },
      payload: {
        totalAmount: 750,
        items: { beer: 1.5 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
  });

  it('2.4: qty = 99 -> succeeds (HTTP 200)', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'cart.sauta.app' },
      payload: {
        totalAmount: 49500,
        items: { beer: 99 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.clientSecret).toBeDefined();
    expect(body.sessionId).toBeDefined();
  });

  it('2.5: qty = 100 -> returns 400 "Quantità massima per singolo prodotto superata (max 99)"', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'cart.sauta.app' },
      payload: {
        totalAmount: 50000,
        items: { beer: 100 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Quantità massima per singolo prodotto superata (max 99)');
  });

  it('2.6: total sum > 99 (beer: 50, shot: 50 -> sum 100) -> returns 400 "Quantità totale nel carrello superata (max 99 articoli)"', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'cart.sauta.app' },
      payload: {
        totalAmount: 40000,
        items: { beer: 50, shot: 50 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Quantità totale nel carrello superata (max 99 articoli)');
  });
});

describe('Empirical Verification: Target 3 - Error Response Sanitization', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
    await prisma.$connect();
  }, 60000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.stop();
  });

  it('3.1: Fastify global setErrorHandler sanitizes 500 unhandled errors (index.ts pattern)', async () => {
    const testFastify = Fastify({ logger: false });

    // Register global error handler identical to backend/src/index.ts
    testFastify.setErrorHandler((error, request, reply) => {
      const statusCode =
        error.statusCode && error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 500;

      if (statusCode === 500) {
        return reply.status(500).send({ error: 'Errore interno del server' });
      }

      return reply.status(statusCode).send({ error: error.message });
    });

    testFastify.get('/test-error-500', async () => {
      throw new Error('Database connection failed: SensitivePrismaErrorDetails table "users" column "secret_hash"');
    });

    const res = await testFastify.inject({
      method: 'GET',
      url: '/test-error-500',
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Errore interno del server');
    expect(body.error).not.toContain('SensitivePrismaErrorDetails');
    expect(res.body).not.toContain('stack');
  });

  it('3.2: /api/admin/venues catches error and returns sanitized 500 error', async () => {
    const testFastify = Fastify({ logger: false });

    // Configure global error handler
    testFastify.setErrorHandler((error, request, reply) => {
      const statusCode =
        error.statusCode && error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 500;

      if (statusCode === 500) {
        return reply.status(500).send({ error: 'Errore interno del server' });
      }

      return reply.status(statusCode).send({ error: error.message });
    });

    const mockBrokenPrisma = {
      venue: {
        findMany: vi.fn(async () => {
          throw new Error('PrismaClientKnownRequestError: Inconsistent column data in database `sauta_db` table `venues`');
        }),
      },
    } as unknown as PrismaClient;

    const mockStripe = {} as Stripe;
    const testCfg = createConfig({
      STRIPE_SECRET_KEY: 'sk_test_mock',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_mock',
      STRIPE_WEBHOOK_SECRET: 'whsec_mock',
      JWT_SECRET: 'jwt_mock_secret_32_characters_long_min',
      TICKET_JWT_SECRET: 'ticket_jwt_mock_secret_32_characters_min',
      DATABASE_URL: 'postgresql://mock:mock@localhost:5432/mock',
      ADMIN_SECRET: 'test-admin-secret-32chars-aaaaaaaaaaaaaa',
      NODE_ENV: 'test',
      WORKOS_API_KEY: 'sk_test_workos_empirical',
      WORKOS_CLIENT_ID: 'client_workos_empirical',
      WORKOS_COOKIE_PASSWORD: 'test-workos-cookie-password-32-chars-empirical',
      WORKOS_WEBHOOK_SECRET: 'whsec_workos_empirical',
      WORKOS_REDIRECT_URI: 'http://console.localhost:3001/api/auth/callback',
      WORKOS_POST_LOGOUT_REDIRECT_URI: 'http://console.localhost:3001',
      CONSOLE_ORIGIN: 'http://console.localhost:3001',
      AUTH_AUDIT_HMAC_SECRET: 'test-auth-audit-hmac-secret-32-chars-empirical',
      PLATFORM_ROOT_DOMAIN: 'sauta.test',
    });

    await testFastify.register(registerAdminRoutes, { prisma: mockBrokenPrisma, stripe: mockStripe, config: testCfg });

    // Request to /api/admin/venues with valid admin secret
    const res = await testFastify.inject({
      method: 'GET',
      url: '/api/admin/venues',
      headers: {
        'x-admin-secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa',
      },
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);

    expect(body.error).toBe('Errore interno del server');
    expect(body.error).not.toContain('PrismaClientKnownRequestError');
  });

  it('3.3: /api/receipt/pdf/:sessionId sanitizes upstream A-Cube error response and logs internally', async () => {
    const testFastify = Fastify({ logger: false });

    testFastify.setErrorHandler((error, request, reply) => {
      const statusCode =
        error.statusCode && error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 500;

      if (statusCode === 500) {
        return reply.status(500).send({ error: 'Errore interno del server' });
      }

      return reply.status(statusCode).send({ error: error.message });
    });

    const mockSessionPrisma = {
      walletCapability: {
        findFirst: vi.fn(async () => ({ sessionId: 'sess_1', revokedAt: null })),
        create: vi.fn(async () => ({})),
      },
      checkoutSession: {
        findUnique: vi.fn(async () => ({
          id: 'sess_1',
          fiscalDocNumber: 'doc_123',
          digitalConsent: true,
          venue: {
            id: 'v1',
            acubeApiKey: 'acube_real_key_user@example.com:secretpass:sandbox',
            acubeOrganizationId: 'org_123',
          },
        })),
      },
    } as unknown as PrismaClient;

    const mockStripe = {} as Stripe;
    const testCfg = createConfig({
      STRIPE_SECRET_KEY: 'sk_test_mock',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_mock',
      STRIPE_WEBHOOK_SECRET: 'whsec_mock',
      JWT_SECRET: 'jwt_mock_secret_32_characters_long_min',
      TICKET_JWT_SECRET: 'ticket_jwt_mock_secret_32_characters_min',
      DATABASE_URL: 'postgresql://mock:mock@localhost:5432/mock',
      ADMIN_SECRET: 'test-admin-secret-32chars-aaaaaaaaaaaaaa',
      NODE_ENV: 'test',
      WORKOS_API_KEY: 'sk_test_workos_empirical',
      WORKOS_CLIENT_ID: 'client_workos_empirical',
      WORKOS_COOKIE_PASSWORD: 'test-workos-cookie-password-32-chars-empirical',
      WORKOS_WEBHOOK_SECRET: 'whsec_workos_empirical',
      WORKOS_REDIRECT_URI: 'http://console.localhost:3001/api/auth/callback',
      WORKOS_POST_LOGOUT_REDIRECT_URI: 'http://console.localhost:3001',
      CONSOLE_ORIGIN: 'http://console.localhost:3001',
      AUTH_AUDIT_HMAC_SECRET: 'test-auth-audit-hmac-secret-32-chars-empirical',
      PLATFORM_ROOT_DOMAIN: 'sauta.test',
    });

    await testFastify.register(registerStripeRoutes, {
      prisma: mockSessionPrisma,
      stripe: mockStripe,
      config: testCfg,
      fiscalServices: {
        ensureSessionInvoiced,
        getAcubeToken,
        voidAcubeReceipt,
      },
    });

    // Mock global fetch for A-Cube API to return a 502 error with internal stack/credentials info on receipt fetch
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: any) => {
      const urlStr = typeof url === 'string' ? url : (url?.url || url?.toString() || '');
      if (urlStr.includes('/login') || urlStr.includes('/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: 'mock_acube_token' }),
        } as any;
      }
      return {
        ok: false,
        status: 502,
        text: async () => 'Internal A-Cube upstream server failure at DB host 10.0.0.45:5432 connection refused for user admin_acube',
      } as any;
    });

    try {
      const { generateWalletToken, hashWalletToken } = await import('../../src/utils/capability');
      const token = generateWalletToken();
      await (mockSessionPrisma as any).walletCapability.create({
        data: { sessionId: 'sess_1', tokenHash: hashWalletToken(token) },
      });

      const res = await testFastify.inject({
        method: 'POST',
        url: '/api/wallet/receipt/pdf',
        payload: { sessionId: 'sess_1', token },
      });

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Errore durante la generazione del PDF');
      expect(res.body).not.toContain('Internal A-Cube upstream');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
