import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { execSync } from 'child_process';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, stopTestDb, isDockerAvailable, type TestDb } from '../db';
import {
  buildPaymentIntentSucceededEvent,
  generateWebhookSignature,
} from '../stripe-helpers';

const TEST_WEBHOOK_SECRET = 'whsec_test_secret_for_integration';

describe.skipIf(!(await isDockerAvailable()))('Webhook Stripe — integration con DB reale', () => {
  let testDb: TestDb;
  let app: TestApp;
  let prisma: PrismaClient;
  let stripe: Stripe;

  beforeAll(async () => {
    // Avvia container + migra UNA volta sola per tutta la suite
    testDb = await startTestDb();
    execSync('npx prisma migrate deploy --schema=prisma/schema.prisma', {
      env: { ...process.env, DATABASE_URL: testDb.url },
      stdio: 'pipe',
      cwd: process.cwd(),
    });
  }, 60000);

  beforeEach(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDb.url } } });
    await prisma.$connect();

    // Pulisci tutte le tabelle (isola ogni test)
    await prisma.fiscalLog.deleteMany();
    await prisma.ticket.deleteMany();
    await prisma.checkoutSession.deleteMany();
    await prisma.product.deleteMany();
    await prisma.venue.deleteMany();

    // Seed minimo: venue + product
    await prisma.venue.create({
      data: {
        id: 'venue-test-1',
        name: 'Test Discoteca',
        acubeApiKey: 'acube_key_test_123',
        acubeOrganizationId: 'org_test_123',
        products: {
          create: [{ slug: 'vodka-redbull', name: 'Vodka Redbull', price: 1000 }],
        },
      },
    });

    app = await createTestApp(prisma, {
      stripeSecretKey: 'sk_test_placeholder',
      config: { STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET } as any,
    });
    stripe = app.stripe;
  });

  afterEach(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  afterAll(async () => {
    await stopTestDb();
  });

  it('rifiuta webhook con firma invalida (400)', async () => {
    const { payload } = buildPaymentIntentSucceededEvent('s1', 'venue-test-1', 1000);

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=123,v1=invalid_signature',
      },
      payload,
    });

    expect(res.statusCode).toBe(400);
  });

  it('accetta webhook con firma valida e processa pagamento (200)', async () => {
    const session = await prisma.checkoutSession.create({
      data: {
        venueId: 'venue-test-1',
        totalAmount: 1000,
        status: 'pending',
        digitalConsent: true,
        tickets: {
          create: [{ venueId: 'venue-test-1', productName: 'vodka-redbull', price: 1000 }],
        },
      },
    });

    const { payload, paymentIntentId } = buildPaymentIntentSucceededEvent(
      session.id,
      'venue-test-1',
      1000
    );
    const signature = generateWebhookSignature(stripe, payload, TEST_WEBHOOK_SECRET);

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      payload,
    });

    expect(res.statusCode).toBe(200);

    const updated = await prisma.checkoutSession.findUnique({ where: { id: session.id } });
    expect(updated?.status).toBe('paid');
    expect(updated?.stripePaymentIntentId).toBe(paymentIntentId);

    const tickets = await prisma.ticket.findMany({ where: { sessionId: session.id } });
    expect(tickets.every((t) => t.status === 'valid')).toBe(true);
  });

  it('skip idempotente: webhook su sessione già paid non rielabora', async () => {
    const session = await prisma.checkoutSession.create({
      data: {
        venueId: 'venue-test-1',
        totalAmount: 1000,
        status: 'paid',
        stripePaymentIntentId: 'pi_old',
        digitalConsent: true,
        tickets: {
          create: [{ venueId: 'venue-test-1', productName: 'vodka-redbull', price: 1000, status: 'valid' }],
        },
      },
    });

    const { payload } = buildPaymentIntentSucceededEvent(session.id, 'venue-test-1', 1000);
    const signature = generateWebhookSignature(stripe, payload, TEST_WEBHOOK_SECRET);

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });

    expect(res.statusCode).toBe(200);

    const updated = await prisma.checkoutSession.findUnique({ where: { id: session.id } });
    expect(updated?.stripePaymentIntentId).toBe('pi_old');
  });

  it('[FIX A] fattura subito la sessione appena pagata (fiscalStatus → invoiced)', async () => {
    const session = await prisma.checkoutSession.create({
      data: {
        venueId: 'venue-test-1',
        totalAmount: 1000,
        status: 'pending',
        digitalConsent: true,
        tickets: {
          create: [{ venueId: 'venue-test-1', productName: 'vodka-redbull', price: 1000 }],
        },
      },
    });

    const { payload } = buildPaymentIntentSucceededEvent(session.id, 'venue-test-1', 1000);
    const signature = generateWebhookSignature(stripe, payload, TEST_WEBHOOK_SECRET);

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });

    expect(res.statusCode).toBe(200);

    // venue-test-1 usa acube_key_test_123 → scontrino mock (consentito in test)
    const updated = await prisma.checkoutSession.findUnique({ where: { id: session.id } });
    expect(updated?.status).toBe('paid');
    expect(updated?.fiscalStatus).toBe('invoiced');
    expect(updated?.fiscalDocNumber).toBe('rec_sandbox_mock_999');
  });

  it('[FIX A] webhook duplicato su sessione paid non fatturata ritenta la fatturazione', async () => {
    // Simula la finestra di perdita: pagata ma mai fatturata (crash/errore A-Cube)
    const session = await prisma.checkoutSession.create({
      data: {
        venueId: 'venue-test-1',
        totalAmount: 1000,
        status: 'paid',
        fiscalStatus: 'pending',
        stripePaymentIntentId: 'pi_old',
        digitalConsent: true,
        tickets: {
          create: [{ venueId: 'venue-test-1', productName: 'vodka-redbull', price: 1000, status: 'valid' }],
        },
      },
    });

    const { payload } = buildPaymentIntentSucceededEvent(session.id, 'venue-test-1', 1000);
    const signature = generateWebhookSignature(stripe, payload, TEST_WEBHOOK_SECRET);

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });

    expect(res.statusCode).toBe(200);

    const updated = await prisma.checkoutSession.findUnique({ where: { id: session.id } });
    expect(updated?.stripePaymentIntentId).toBe('pi_old'); // idempotenza preservata
    expect(updated?.fiscalStatus).toBe('invoiced'); // finestra chiusa dal retry
    expect(updated?.fiscalDocNumber).toBe('rec_sandbox_mock_999');
  });

  it('[FIX 0.7] skip su sessione refunded (non pending)', async () => {
    const session = await prisma.checkoutSession.create({
      data: {
        venueId: 'venue-test-1',
        totalAmount: 1000,
        status: 'refunded',
        digitalConsent: true,
        tickets: { create: [{ venueId: 'venue-test-1', productName: 'x', price: 1000 }] },
      },
    });

    const { payload } = buildPaymentIntentSucceededEvent(session.id, 'venue-test-1', 1000);
    const signature = generateWebhookSignature(stripe, payload, TEST_WEBHOOK_SECRET);

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });

    expect(res.statusCode).toBe(200);

    const updated = await prisma.checkoutSession.findUnique({ where: { id: session.id } });
    expect(updated?.status).toBe('refunded');
  });

  it('[FIX 0.1] usa rawBody per verifica firma (non req.body parsed)', async () => {
    const session = await prisma.checkoutSession.create({
      data: {
        venueId: 'venue-test-1',
        totalAmount: 500,
        status: 'pending',
        digitalConsent: true,
        tickets: { create: [{ venueId: 'venue-test-1', productName: 'x', price: 500 }] },
      },
    });

    const { payload } = buildPaymentIntentSucceededEvent(session.id, 'venue-test-1', 500);
    const signature = generateWebhookSignature(stripe, payload, TEST_WEBHOOK_SECRET);

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });

    expect(res.statusCode).toBe(200);
  });

  it('[FIX 0.6] webhook ritorna 5xx su errore DB (triggera retry Stripe)', async () => {
    // Crea una sessione pending con un prisma funzionante
    const session = await prisma.checkoutSession.create({
      data: {
        venueId: 'venue-test-1',
        totalAmount: 1000,
        status: 'pending',
        digitalConsent: true,
        tickets: { create: [{ venueId: 'venue-test-1', productName: 'x', price: 1000 }] },
      },
    });

    const { payload } = buildPaymentIntentSucceededEvent(session.id, 'venue-test-1', 1000);
    const signature = generateWebhookSignature(stripe, payload, TEST_WEBHOOK_SECRET);

    // Crea un app con prisma che punta a DB inesistente → errore reale
    const badPrisma = new PrismaClient({
      datasources: { db: { url: 'postgresql://x:x@127.0.0.1:1/nonexistent?schema=public' } },
    });
    const badApp = await createTestApp(badPrisma, {
      stripeSecretKey: 'sk_test_placeholder',
      config: { STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET } as any,
    });

    const res = await badApp.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });

    // Deve ritornare 5xx (non 200) per triggerare retry di Stripe
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.statusCode).toBeLessThan(600);

    await badApp.close();
    await badPrisma.$disconnect();
  });

  it('deduplica eventi con lo stesso event.id tramite ProcessedWebhookEvent', async () => {
    const session = await prisma.checkoutSession.create({
      data: {
        venueId: 'venue-test-1',
        totalAmount: 1000,
        status: 'pending',
        digitalConsent: true,
        tickets: {
          create: [{ venueId: 'venue-test-1', productName: 'vodka-redbull', price: 1000 }],
        },
      },
    });

    const { payload } = buildPaymentIntentSucceededEvent(session.id, 'venue-test-1', 1000);
    // Assegna un id evento esplicito
    const parsedPayload = JSON.parse(payload);
    parsedPayload.id = 'evt_test_dedup_12345';
    const jsonPayload = JSON.stringify(parsedPayload);
    const signature = generateWebhookSignature(stripe, jsonPayload, TEST_WEBHOOK_SECRET);

    // Primo invio: processato con successo
    const res1 = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload: jsonPayload,
    });
    expect(res1.statusCode).toBe(200);

    // Verifica che ProcessedWebhookEvent sia stato salvato
    const processed = await prisma.processedWebhookEvent.findUnique({
      where: { id: 'evt_test_dedup_12345' },
    });
    expect(processed).not.toBeNull();
    expect(processed?.eventType).toBe('payment_intent.succeeded');

    // Secondo invio (duplicato esatto con stesso event.id): deduplicato con 200 { deduplicated: true }
    const res2 = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload: jsonPayload,
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.deduplicated).toBe(true);
  });
});
