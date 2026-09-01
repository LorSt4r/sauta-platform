import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import nock from 'nock';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, type TestDbHandle } from '../db';
import { createPrismaClient } from '../../src/utils/prisma';

describe('A-Cube Sandbox API Integration [R2 & R4]', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;
  let app: TestApp;

  beforeAll(async () => {
    nock.restore();
    db = await startTestDb();
    prisma = createPrismaClient(db.url);
    await prisma.$connect();
    nock.activate();

    const mockPaymentIntentsCreate = vi.fn(async (params: any) => ({
      id: 'pi_test_' + Math.random().toString(36).substring(2, 18),
      object: 'payment_intent',
      amount: params.amount,
      currency: params.currency,
      client_secret: 'pi_test_secret_' + Math.random().toString(36).substring(2, 18),
      status: 'requires_payment_method',
      metadata: params.metadata,
    }));

    const mockStripe = {
      paymentIntents: {
        create: mockPaymentIntentsCreate,
      },
    } as unknown as Stripe;

    app = await createTestApp(prisma, {
      stripeSecretKey: 'sk_test_mock',
      stripe: mockStripe,
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await db?.stop();
  });

  beforeEach(async () => {
    nock.cleanAll();

    await prisma.fiscalLog.deleteMany();
    await prisma.ticket.deleteMany();
    await prisma.checkoutSession.deleteMany();
    await prisma.product.deleteMany();
    await prisma.venue.deleteMany();

    // Create cloud_api venue
    await prisma.venue.create({
      data: {
        id: 'v_cloud',
        name: 'Cloud Disco',
        isActive: true,
        acubeApiKey: 'acube_test_key_123',
        acubeOrganizationId: 'org_test_123',
        domains: {
          create: {
            hostname: 'cloud.sauta.app',
            type: 'PLATFORM',
            status: 'VERIFIED',
            isPrimary: true,
            verifiedAt: new Date(),
          },
        },
        products: {
          create: [
            { id: 'p1', slug: 'vodka', name: 'Vodka Lemon', price: 1000, vatRate: 10.0 },
          ],
        },
      },
    });
  });

  it('checkout/confirm should call A-Cube and update session on success when fiscalMode is cloud_api', async () => {
    // 1. Create a checkout session
    const checkoutRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'cloud.sauta.app' },
      payload: {
        totalAmount: 2000,
        items: { vodka: 2 },
        digitalConsent: true,
      },
    });
    expect(checkoutRes.statusCode).toBe(200);
    const { sessionId } = JSON.parse(checkoutRes.body);

    // Mock A-Cube API response
    const scope = nock('https://api-sandbox.acubeapi.com')
      .post('/receipts', (body) => {
        expect(body.electronic_payment_amount).toBe(20.00);
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).toEqual({
          description: 'Vodka Lemon',
          unit_price: 10.00,
          vat_rate_code: '10',
          quantity: 2,
        });
        return true;
      })
      .reply(200, {
        uuid: 'acube_uuid_123',
        document_number: 'RT-001',
        z_number: 'Z-001',
      });

    // 2. Confirm checkout
    const confirmRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout/confirm',
      payload: {
        paymentIntentId: `mock_${sessionId}`,
      },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(scope.isDone()).toBe(true);

    // 3. Verify database state
    const session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
    });
    expect(session?.fiscalStatus).toBe('invoiced');
    expect(session?.fiscalReceiptUrl).toBe(`/api/receipt/pdf/${sessionId}`);
  });

  it('[FIX A] checkout/confirm non perde il pagamento su errore A-Cube: 200 + invoicing_failed per il reconciler', async () => {
    // 1. Create a checkout session
    const checkoutRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'cloud.sauta.app' },
      payload: {
        totalAmount: 1000,
        items: { vodka: 1 },
        digitalConsent: true,
      },
    });
    expect(checkoutRes.statusCode).toBe(200);
    const { sessionId } = JSON.parse(checkoutRes.body);

    // Mock A-Cube API error response
    nock('https://api-sandbox.acubeapi.com')
      .post('/receipts')
      .reply(400, 'Bad Request: Invalid VAT rate');

    // 2. [FIX A] Il confirm NON fallisce più: il pagamento è confermato, la
    //    fatturazione fallita è marcata invoicing_failed e ritentata dal reconciler.
    const confirmRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout/confirm',
      payload: {
        paymentIntentId: `mock_${sessionId}`,
      },
    });
    expect(confirmRes.statusCode).toBe(200);

    // 3. Verify database state: pagamento paid, fatturazione marcata come fallita, nessun PDF
    const session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
    });
    expect(session?.status).toBe('paid');
    expect(session?.fiscalStatus).toBe('invoicing_failed');
    expect(session?.fiscalReceiptUrl).toBeNull();
  });

  it('session/void should call A-Cube void endpoint on cloud_api session', async () => {
    // 1. Create and confirm a paid session
    const checkoutRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'cloud.sauta.app' },
      payload: {
        totalAmount: 1000,
        items: { vodka: 1 },
        digitalConsent: true,
      },
    });
    const { sessionId } = JSON.parse(checkoutRes.body);

    nock('https://api-sandbox.acubeapi.com')
      .post('/receipts')
      .reply(200, {
        uuid: 'rec_sandbox_888',
        status: 'new',
      });

    await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout/confirm',
      payload: {
        paymentIntentId: `mock_${sessionId}`,
      },
    });

    // Mock A-Cube Void API response
    const voidScope = nock('https://api-sandbox.acubeapi.com')
      .delete('/receipts/rec_sandbox_888')
      .reply(204);

    // 2. Call void API
    const voidRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/session/void',
      headers: {
        'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa',
      },
      payload: {
        sessionId,
        venueId: 'v_cloud',
        reason: 'errore_cassa',
        voidedById: 'user_admin',
      },
    });
    expect(voidRes.statusCode).toBe(200);
    expect(voidScope.isDone()).toBe(true);

    // 3. Verify database state
    const session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
    });
    expect(session?.fiscalStatus).toBe('voided');
  });

  it('GET /api/receipt/pdf/:sessionId should proxy A-Cube PDF and disable CSP headers even when CSP is enabled globally', async () => {
    const cspApp = await createTestApp(prisma, {
      stripeSecretKey: 'sk_test_mock',
    });

    try {
      const session = await prisma.checkoutSession.create({
        data: {
          id: 'sess_pdf_csp_test',
          venueId: 'v_cloud',
          totalAmount: 1000,
          status: 'paid',
          fiscalStatus: 'invoiced',
          fiscalDocNumber: 'rec_uuid_99999',
          fiscalReceiptUrl: '/api/receipt/pdf/sess_pdf_csp_test',
          digitalConsent: true,
          digitalConsentTimestamp: new Date(),
        }
      });

      const { generateWalletToken, hashWalletToken } = await import('../../src/utils/capability');
      const token = generateWalletToken();
      await (prisma as any).walletCapability.create({
        data: { sessionId: session.id, tokenHash: hashWalletToken(token) },
      });

      const mockPdfBuffer = Buffer.from('%PDF-1.4 mock content with CSP');
      const scope = nock('https://api-sandbox.acubeapi.com')
        .get('/receipts/rec_uuid_99999')
        .reply(200, mockPdfBuffer, {
          'Content-Type': 'application/pdf',
        });

      const res = await cspApp.fastify.inject({
        method: 'POST',
        url: '/api/wallet/receipt/pdf',
        payload: { sessionId: session.id, token },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('inline; filename="receipt-rec_uuid_99999.pdf"');

      // Verify CSP is disabled on PDF route
      expect(res.headers['content-security-policy']).toBeUndefined();
      expect(res.body).toBe(mockPdfBuffer.toString());
      expect(scope.isDone()).toBe(true);

      // Verify that another endpoint on cspApp (like /ping) DOES have CSP header
      const pingRes = await cspApp.fastify.inject({
        method: 'GET',
        url: '/ping',
      });
      expect(pingRes.headers['content-security-policy']).toBeDefined();

    } finally {
      await cspApp.close();
    }
  });
});
