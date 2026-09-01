import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, stopTestDb, TestDb } from '../db';
import { createTestApp, TestApp } from '../helpers';
import { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '../../src/utils/prisma';
import { generateWalletToken, hashWalletToken } from '../../src/utils/capability';
import { signToken } from '../../src/utils/jwt';

describe('Wave 9B — Access Control & Wallet Capability Tests', () => {
  let db: TestDb;
  let prisma: PrismaClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = createPrismaClient(db.url);
    await prisma.$connect();
    app = await createTestApp(prisma);
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    await prisma?.$disconnect();
    await stopTestDb();
  });

  it('1. Session ID corretto + token errato -> negato in query wallet', async () => {
    const venue = await prisma.venue.create({
      data: {
        name: 'Venue Capability Test 1',
        acubeApiKey: 'SECRET_ACUBE_KEY_DO_NOT_LEAK',
        acubeOrganizationId: 'SECRET_ACUBE_ORG_123',
        stripeAccountId: 'acct_123456789',
      },
    });

    const session = await prisma.checkoutSession.create({
      data: {
        venueId: venue.id,
        totalAmount: 1000,
        status: 'paid',
        digitalConsent: true,
        digitalConsentTimestamp: new Date(),
      },
    });

    const validToken = generateWalletToken();
    await prisma.walletCapability.create({
      data: {
        sessionId: session.id,
        tokenHash: hashWalletToken(validToken),
      },
    });

    // Query con token errato per sessione valida
    const invalidQuery = await app.fastify.inject({
      method: 'POST',
      url: '/api/wallet/query',
      payload: { items: [{ sessionId: session.id, token: 'swc_' + '0'.repeat(64) }] },
    });

    expect(invalidQuery.statusCode).toBe(200);
    const body = invalidQuery.json();
    expect(body.sessions).toEqual([]);
  });

  it('2. Token di sessione A applicato a sessione B -> negato', async () => {
    const venue = await prisma.venue.create({
      data: { name: 'Venue Capability Test 2' },
    });

    const sessionA = await prisma.checkoutSession.create({
      data: { venueId: venue.id, totalAmount: 1000, status: 'paid', digitalConsent: true },
    });
    const sessionB = await prisma.checkoutSession.create({
      data: { venueId: venue.id, totalAmount: 2000, status: 'paid', digitalConsent: true },
    });

    const tokenA = generateWalletToken();
    await prisma.walletCapability.create({
      data: { sessionId: sessionA.id, tokenHash: hashWalletToken(tokenA) },
    });

    // Query per sessionB usando tokenA
    const crossQuery = await app.fastify.inject({
      method: 'POST',
      url: '/api/wallet/query',
      payload: { items: [{ sessionId: sessionB.id, token: tokenA }] },
    });

    expect(crossQuery.json().sessions).toEqual([]);
  });

  it('3. Token revocato -> negato', async () => {
    const venue = await prisma.venue.create({
      data: { name: 'Venue Capability Test 3' },
    });

    const session = await prisma.checkoutSession.create({
      data: { venueId: venue.id, totalAmount: 1500, status: 'paid', digitalConsent: true },
    });

    const token = generateWalletToken();
    await prisma.walletCapability.create({
      data: {
        sessionId: session.id,
        tokenHash: hashWalletToken(token),
        revokedAt: new Date(),
      },
    });

    const revokedQuery = await app.fastify.inject({
      method: 'POST',
      url: '/api/wallet/query',
      payload: { items: [{ sessionId: session.id, token }] },
    });

    expect(revokedQuery.json().sessions).toEqual([]);
  });

  it('4. Batch query oltre il limite di 20 item -> 400 Bad Request', async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      sessionId: `sess_${i}`,
      token: generateWalletToken(),
    }));

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/wallet/query',
      payload: { items },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('20');
  });

  it('5. DTO Sanitization: nessuna proprietà interna A-Cube/Stripe nei payload DTO', async () => {
    const secretAcubeKey = 'SUPER_SECRET_ACUBE_API_KEY_12345';
    const secretOrgId = 'SUPER_SECRET_ORG_ID_67890';
    const secretStripeAccount = 'acct_SECRET_STRIPE_CONNECTED';

    const venue = await prisma.venue.create({
      data: {
        name: 'Secret Leak Test Venue',
        acubeApiKey: secretAcubeKey,
        acubeOrganizationId: secretOrgId,
        stripeAccountId: secretStripeAccount,
      },
    });

    const session = await prisma.checkoutSession.create({
      data: {
        venueId: venue.id,
        totalAmount: 1000,
        status: 'paid',
        digitalConsent: true,
        digitalConsentTimestamp: new Date(),
        tickets: {
          create: [{ venueId: venue.id, productName: 'Vodka', price: 1000, status: 'valid' }],
        },
      },
    });

    const token = generateWalletToken();
    await prisma.walletCapability.create({
      data: { sessionId: session.id, tokenHash: hashWalletToken(token) },
    });

    const queryRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/wallet/query',
      payload: { items: [{ sessionId: session.id, token }] },
    });

    expect(queryRes.statusCode).toBe(200);
    const bodyStr = queryRes.body;

    expect(bodyStr).not.toContain(secretAcubeKey);
    expect(bodyStr).not.toContain(secretOrgId);
    expect(bodyStr).not.toContain(secretStripeAccount);
    expect(bodyStr).not.toContain('acubeApiKey');
    expect(bodyStr).not.toContain('acubeOrganizationId');
    expect(bodyStr).not.toContain('stripeAccountId');
    expect(bodyStr).not.toContain('tokenHash');
    expect(bodyStr).not.toContain(token);
  });

  it('6. Ricevuta senza consenso digitale -> negata (403)', async () => {
    const venue = await prisma.venue.create({
      data: { name: 'Venue Consent Test' },
    });

    const session = await prisma.checkoutSession.create({
      data: {
        venueId: venue.id,
        totalAmount: 1000,
        status: 'paid',
        digitalConsent: false, // Consenso negato
      },
    });

    const token = generateWalletToken();
    await prisma.walletCapability.create({
      data: { sessionId: session.id, tokenHash: hashWalletToken(token) },
    });

    const receiptRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/wallet/receipt',
      payload: { sessionId: session.id, token },
    });

    expect(receiptRes.statusCode).toBe(403);
  });

  it('7. consumeToken scaduto, audience errata e doppio swipe', async () => {
    const venue = await prisma.venue.create({
      data: { name: 'Swipe Test Venue' },
    });

    const session = await prisma.checkoutSession.create({
      data: {
        venueId: venue.id,
        totalAmount: 1000,
        status: 'paid',
        digitalConsent: true,
        digitalConsentTimestamp: new Date(),
        tickets: {
          create: [{ venueId: venue.id, productName: 'Mojito', price: 1000, status: 'valid' }],
        },
      },
      include: { tickets: true },
    });

    const ticket = session.tickets[0]!;
    const token = generateWalletToken();
    await prisma.walletCapability.create({
      data: { sessionId: session.id, tokenHash: hashWalletToken(token) },
    });

    // 7a. Richiesta consumeToken autorizzata
    const consumeTokenRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/wallet/consume-token',
      payload: { sessionId: session.id, token, ticketId: ticket.id },
    });

    expect(consumeTokenRes.statusCode).toBe(200);
    const { consumeToken } = consumeTokenRes.json();
    expect(consumeToken).toBeDefined();

    // 7b. Consumo valido
    const consumeRes1 = await app.fastify.inject({
      method: 'POST',
      url: '/api/consume',
      payload: { consumeToken },
    });

    expect(consumeRes1.statusCode).toBe(200);
    expect(consumeRes1.json().success).toBe(true);

    // 7c. Doppio swipe -> 409 Conflict
    const consumeRes2 = await app.fastify.inject({
      method: 'POST',
      url: '/api/consume',
      payload: { consumeToken },
    });

    expect(consumeRes2.statusCode).toBe(409);

    // 7d. Token con audience errata su ticket valido -> 401
    const ticket2 = await prisma.ticket.create({
      data: { sessionId: session.id, venueId: venue.id, productName: 'Spritz', price: 800, status: 'valid' },
    });

    const badAudienceToken = signToken(
      { ticketId: ticket2.id, venueId: venue.id },
      app.config.TICKET_JWT_SECRET,
      { expiresIn: '5m', audience: 'wrong_aud' }
    );

    const badAudRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/consume',
      payload: { consumeToken: badAudienceToken },
    });

    expect(badAudRes.statusCode).toBe(401);

    const expiredToken = signToken(
      { ticketId: ticket2.id, venueId: venue.id },
      app.config.TICKET_JWT_SECRET,
      { expiresIn: '-1s', audience: 'consume', subject: ticket2.id }
    );
    const expiredRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/consume',
      payload: { consumeToken: expiredToken },
    });
    expect(expiredRes.statusCode).toBe(401);

    const noAudienceToken = signToken(
      { ticketId: ticket2.id, venueId: venue.id },
      app.config.TICKET_JWT_SECRET,
      { expiresIn: '5m', subject: ticket2.id }
    );
    const noAudienceRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/consume',
      payload: { consumeToken: noAudienceToken },
    });
    expect(noAudienceRes.statusCode).toBe(401);

    const wrongSubjectToken = signToken(
      { ticketId: ticket2.id, venueId: venue.id },
      app.config.TICKET_JWT_SECRET,
      { expiresIn: '5m', audience: 'consume', subject: 'different-ticket' }
    );
    const wrongSubjectRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/consume',
      payload: { consumeToken: wrongSubjectToken },
    });
    expect(wrongSubjectRes.statusCode).toBe(401);

    const legacyFieldRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/consume',
      payload: { qrToken: consumeToken },
    });
    expect(legacyFieldRes.statusCode).toBe(400);
  });

  it('8. XSS Payload in nome venue non eseguibile nel DTO', async () => {
    const xssName = '<script>alert("xss")</script>Disco Club';
    const venue = await prisma.venue.create({
      data: { name: xssName },
    });

    const session = await prisma.checkoutSession.create({
      data: {
        venueId: venue.id,
        totalAmount: 1000,
        status: 'paid',
        digitalConsent: true,
        digitalConsentTimestamp: new Date(),
      },
    });

    const token = generateWalletToken();
    await prisma.walletCapability.create({
      data: { sessionId: session.id, tokenHash: hashWalletToken(token) },
    });

    const queryRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/wallet/query',
      payload: { items: [{ sessionId: session.id, token }] },
    });

    expect(queryRes.statusCode).toBe(200);
    const sessions = queryRes.json().sessions;
    expect(sessions[0].venue.name).toBe(xssName);
  });

  it('9. rifiuta una risposta wallet oltre il limite di 512 KiB', async () => {
    const venue = await prisma.venue.create({
      data: { name: 'Oversized Wallet Venue' },
    });
    const session = await prisma.checkoutSession.create({
      data: {
        venueId: venue.id,
        totalAmount: 1000,
        status: 'paid',
        tickets: {
          create: [{
            venueId: venue.id,
            productName: 'x'.repeat(600 * 1024),
            price: 1000,
            status: 'valid',
          }],
        },
      },
    });
    const token = generateWalletToken();
    await prisma.walletCapability.create({
      data: { sessionId: session.id, tokenHash: hashWalletToken(token) },
    });

    const response = await app.fastify.inject({
      method: 'POST',
      url: '/api/wallet/query',
      payload: { items: [{ sessionId: session.id, token }] },
    });
    expect(response.statusCode).toBe(413);
  });

  it('10. applica il rate limit specifico di 30 query wallet al minuto', async () => {
    let limitedStatus = 0;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const response = await app.fastify.inject({
        method: 'POST',
        url: '/api/wallet/query',
        payload: {
          items: [{
            sessionId: `unknown-${attempt}`,
            token: generateWalletToken(),
          }],
        },
      });
      if (response.statusCode === 429) {
        limitedStatus = response.statusCode;
        break;
      }
    }
    expect(limitedStatus).toBe(429);
  });
});
