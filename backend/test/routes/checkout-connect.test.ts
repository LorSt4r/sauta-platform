import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, type TestDbHandle } from '../db';
import { hashWalletToken, isValidTokenFormat } from '../../src/utils/capability';

describe('Checkout with Stripe Connect [FIX 3.2]', () => {
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
      transfer_data: params.transfer_data,
      application_fee_amount: params.application_fee_amount,
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

    // Venue con stripeAccountId valido
    await prisma.venue.create({
      data: {
        id: 'v1',
        name: 'Test Disco',
        isActive: true,
        stripeAccountId: 'acct_1NqK7x2eZvKYlo2C0aB',
        applicationFeePercent: 2.9,
        domains: {
          create: {
            hostname: 'v1.sauta.app',
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

    // Venue senza stripeAccountId (fallback pagamento diretto)
    await prisma.venue.create({
      data: {
        id: 'v2',
        name: 'No Connect Disco',
        isActive: true,
        domains: {
          create: {
            hostname: 'v2.sauta.app',
            type: 'PLATFORM',
            status: 'VERIFIED',
            isPrimary: true,
            verifiedAt: new Date(),
          },
        },
        products: {
          create: { id: 'p2', slug: 'gin', name: 'Gin Tonic', price: 1200, vatRate: 10.0 },
        },
      },
    });
  });

  it('usa transfer_data + application_fee quando venue ha stripeAccountId valido', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'v1.sauta.app' },
      payload: {
        totalAmount: 2000,
        items: { vodka: 2 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockPaymentIntentsCreate).toHaveBeenCalledTimes(1);

    const callArgs = mockPaymentIntentsCreate.mock.calls[0][0];
    expect(callArgs.transfer_data).toBeDefined();
    expect(callArgs.transfer_data.destination).toBe('acct_1NqK7x2eZvKYlo2C0aB');
    // applicationFeePercent 2.9% su 2000 cents = 58 cents
    expect(callArgs.application_fee_amount).toBe(58);

    const body = res.json();
    expect(isValidTokenFormat(body.walletToken)).toBe(true);
    const capability = await prisma.walletCapability.findUnique({
      where: { sessionId: body.sessionId },
    });
    expect(capability?.tokenHash).toBe(hashWalletToken(body.walletToken));
    expect(capability?.tokenHash).not.toContain(body.walletToken);
  });

  it('NON usa transfer_data quando venue NON ha stripeAccountId (fallback pagamento diretto)', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'v2.sauta.app' },
      payload: {
        totalAmount: 1200,
        items: { gin: 1 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const callArgs = mockPaymentIntentsCreate.mock.calls[0][0];
    expect(callArgs.transfer_data).toBeUndefined();
    expect(callArgs.application_fee_amount).toBeUndefined();
  });

  it('fallback a pagamento diretto se stripeAccountId è invalido (no acct_ prefix)', async () => {
    await prisma.venue.update({
      where: { id: 'v1' },
      data: { stripeAccountId: 'invalid-id' },
    });

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'v1.sauta.app' },
      payload: {
        totalAmount: 1000,
        items: { vodka: 1 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const callArgs = mockPaymentIntentsCreate.mock.calls[0][0];
    expect(callArgs.transfer_data).toBeUndefined();
  });

  it('rispetta applicationFeePercent custom del venue', async () => {
    await prisma.venue.update({
      where: { id: 'v1' },
      data: { applicationFeePercent: 5.0 },
    });

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'v1.sauta.app' },
      payload: {
        totalAmount: 1000,
        items: { vodka: 1 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const callArgs = mockPaymentIntentsCreate.mock.calls[0][0];
    // 5% su 1000 = 50
    expect(callArgs.application_fee_amount).toBe(50);
  });

  it('rifiuta checkout per venue disattivata (isActive = false)', async () => {
    await prisma.venue.update({
      where: { id: 'v1' },
      data: { isActive: false },
    });

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'v1.sauta.app' },
      payload: {
        totalAmount: 1000,
        items: { vodka: 1 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('rifiuta checkout se la quantità di un singolo prodotto supera 99', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'v1.sauta.app' },
      payload: {
        totalAmount: 100000,
        items: { vodka: 100 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('Quantità massima per singolo prodotto superata');
  });

  it('rifiuta checkout se la quantità totale nel carrello supera 99', async () => {
    await prisma.product.create({
      data: { id: 'p1_2', venueId: 'v1', slug: 'gin', name: 'Gin', price: 1000, vatRate: 10.0 },
    });

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'v1.sauta.app' },
      payload: {
        totalAmount: 100000,
        items: { vodka: 50, gin: 50 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('Quantità totale nel carrello superata');
  });
});
