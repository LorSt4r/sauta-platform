import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, type TestDbHandle } from '../db';
import { constructWebhookEvent } from '../stripe-helpers';

describe('account.updated webhook [FIX 3.4]', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
    await prisma.$connect();
    app = await createTestApp(prisma);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.fiscalLog.deleteMany();
    await prisma.ticket.deleteMany();
    await prisma.checkoutSession.deleteMany();
    await prisma.product.deleteMany();
    await prisma.venue.deleteMany();
  });

  it('aggiorna Venue.stripeChargesEnabled/StripePayoutsEnabled/StripeOnboardedAt quando account completamente abilitato', async () => {
    await prisma.venue.create({
      data: {
        id: 'v1',
        name: 'Test Disco',
        stripeAccountId: 'acct_test_1234567890abcde',
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
      },
    });

    const event = {
      id: 'evt_test_account_updated',
      object: 'event',
      type: 'account.updated',
      api_version: '2024-06-20',
      created: Date.now() / 1000,
      data: {
        object: {
          id: 'acct_test_1234567890abcde',
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
        },
      },
      livemode: false,
    } as any;

    const { rawBody, signature } = constructWebhookEvent(event);

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);

    const venue = await prisma.venue.findUnique({ where: { id: 'v1' } });
    expect(venue!.stripeChargesEnabled).toBe(true);
    expect(venue!.stripePayoutsEnabled).toBe(true);
    expect(venue!.stripeOnboardedAt).not.toBeNull();
  });

  it('aggiorna solo chargesEnabled (payouts ancora false)', async () => {
    await prisma.venue.create({
      data: {
        id: 'v1',
        name: 'Test Disco',
        stripeAccountId: 'acct_test_1234567890abcde',
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
      },
    });

    const event = {
      id: 'evt_test',
      type: 'account.updated',
      data: {
        object: {
          id: 'acct_test_1234567890abcde',
          charges_enabled: true,
          payouts_enabled: false,
        },
      },
    } as any;

    const { rawBody, signature } = constructWebhookEvent(event);

    await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload: rawBody,
    });

    const venue = await prisma.venue.findUnique({ where: { id: 'v1' } });
    expect(venue!.stripeChargesEnabled).toBe(true);
    expect(venue!.stripePayoutsEnabled).toBe(false);
    expect(venue!.stripeOnboardedAt).toBeNull();
  });

  it('rifiuta account.updated per account non collegato a nessun venue (no error)', async () => {
    const event = {
      id: 'evt_test',
      type: 'account.updated',
      data: {
        object: {
          id: 'acct_unknown_1234567890',
          charges_enabled: true,
          payouts_enabled: true,
        },
      },
    } as any;

    const { rawBody, signature } = constructWebhookEvent(event);

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhook/stripe',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
  });
});
