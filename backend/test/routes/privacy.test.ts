import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, type TestDbHandle } from '../db';

describe('Privacy by Design — Email rimossa [Wave 4]', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;
  let app: TestApp;
  let mockPaymentIntentsCreate: any;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
    await prisma.$connect();

    mockPaymentIntentsCreate = vi.fn(async (params: any) => ({
      id: 'pi_test_' + Math.random().toString(36).substring(2, 18),
      object: 'payment_intent',
      amount: params.amount,
      currency: params.currency,
      client_secret: 'pi_test_secret_' + Math.random().toString(36).substring(2, 18),
      status: 'requires_payment_method',
    }));

    const mockStripe = {
      paymentIntents: { create: mockPaymentIntentsCreate },
    } as unknown as Stripe;

    app = await createTestApp(prisma, { stripeSecretKey: 'sk_test_mock', stripe: mockStripe });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await db?.stop();
  });

  beforeEach(async () => {
    mockPaymentIntentsCreate.mockClear();
    await prisma.fiscalLog.deleteMany();
    await prisma.ticket.deleteMany();
    await prisma.checkoutSession.deleteMany();
    await prisma.product.deleteMany();
    await prisma.venueDomain.deleteMany();
    await prisma.venue.deleteMany();

    await prisma.venue.create({
      data: {
        id: 'v1',
        name: 'Test Disco',
        isActive: true,
        domains: {
          create: {
            hostname: 'privacy.sauta.app',
            type: 'PLATFORM',
            status: 'VERIFIED',
            isPrimary: true,
            verifiedAt: new Date(),
          },
        },
        products: {
          create: { id: 'p1', slug: 'vodka', name: 'Vodka', price: 1000, vatRate: 10.0 },
        },
      },
    });
  });

  it('checkout senza email funziona correttamente (Privacy by Design)', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'privacy.sauta.app' },
      payload: {
        totalAmount: 1000,
        items: { vodka: 1 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.clientSecret).toBeDefined();
    expect(body.sessionId).toBeDefined();
  });

  it('checkout non salva email nel DB quando non fornita', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'privacy.sauta.app' },
      payload: {
        totalAmount: 1000,
        items: { vodka: 1 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = JSON.parse(res.body);
    const session = await prisma.checkoutSession.findUnique({ where: { id: sessionId } });
    expect(session).not.toBeNull();
    expect(session!.email).toBeNull();
  });

  it('PaymentIntent non ha receipt_email quando cliente è anonimo', async () => {
    await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'privacy.sauta.app' },
      payload: {
        totalAmount: 1000,
        items: { vodka: 1 },
        digitalConsent: true,
      },
    });

    expect(mockPaymentIntentsCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockPaymentIntentsCreate.mock.calls[0][0];
    expect(callArgs.receipt_email).toBeUndefined();
  });

  it('consentTimestamp viene salvato quando digitalConsent è true', async () => {
    const before = new Date();
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'privacy.sauta.app' },
      payload: {
        totalAmount: 1000,
        items: { vodka: 1 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = JSON.parse(res.body);
    const session = await prisma.checkoutSession.findUnique({ where: { id: sessionId } });
    expect(session!.digitalConsentTimestamp).not.toBeNull();
    expect(new Date(session!.digitalConsentTimestamp!).getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('checkout rifiuta se digitalConsent è false', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'privacy.sauta.app' },
      payload: {
        totalAmount: 1000,
        items: { vodka: 1 },
        digitalConsent: false,
      },
    });

    expect(res.statusCode).toBe(400);
  });
});
