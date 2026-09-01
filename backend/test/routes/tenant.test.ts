import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, type TestDbHandle } from '../db';
import { createTenantResolver } from '../../src/utils/tenantResolver';

describe('Authoritative Tenant Resolution via Hostname (Wave 9C.0A)', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;
  let app: TestApp;
  let appTrustProxy: TestApp;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
    await prisma.$connect();

    const mockStripe = {
      paymentIntents: {
        create: vi.fn(async (params: any) => ({
          id: 'pi_test_' + Math.random().toString(36).substring(2, 18),
          object: 'payment_intent',
          amount: params.amount,
          currency: params.currency,
          client_secret: 'pi_test_secret_123',
          status: 'requires_payment_method',
        })),
      },
    } as unknown as Stripe;

    app = await createTestApp(prisma, {
      stripeSecretKey: 'sk_test_mock',
      stripe: mockStripe,
      config: { TRUST_PROXY: false },
    });

    appTrustProxy = await createTestApp(prisma, {
      stripeSecretKey: 'sk_test_mock',
      stripe: mockStripe,
      config: { TRUST_PROXY: true },
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await appTrustProxy?.close();
    await prisma?.$disconnect();
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.fiscalLog.deleteMany();
    await prisma.ticket.deleteMany();
    await prisma.checkoutSession.deleteMany();
    await prisma.product.deleteMany();
    await prisma.venueDomain.deleteMany();
    await prisma.venue.deleteMany();

    // Venue A (attiva) con dominio primario a.sauta.app
    await prisma.venue.create({
      data: {
        id: 'venue_a',
        name: 'Venue Alpha',
        isActive: true,
        stripeAccountId: 'acct_1NqK7x2eZvKYlo2A',
        domains: {
          create: {
            hostname: 'a.sauta.app',
            type: 'PLATFORM',
            status: 'VERIFIED',
            isPrimary: true,
            verifiedAt: new Date(),
          },
        },
        products: {
          create: [
            { id: 'p_a1', slug: 'mojito', name: 'Mojito Alpha', price: 900, active: true },
          ],
        },
      },
    });

    // Venue B (attiva) con dominio b.sauta.app
    await prisma.venue.create({
      data: {
        id: 'venue_b',
        name: 'Venue Beta',
        isActive: true,
        stripeAccountId: 'acct_1NqK7x2eZvKYlo2B',
        domains: {
          create: {
            hostname: 'b.sauta.app',
            type: 'PLATFORM',
            status: 'VERIFIED',
            isPrimary: true,
            verifiedAt: new Date(),
          },
        },
        products: {
          create: [
            { id: 'p_b1', slug: 'spritz', name: 'Spritz Beta', price: 700, active: true },
          ],
        },
      },
    });

    // Venue C (sospesa/non attiva) con dominio c.sauta.app
    await prisma.venue.create({
      data: {
        id: 'venue_c',
        name: 'Venue Gamma (Inactive)',
        isActive: false,
        domains: {
          create: {
            hostname: 'c.sauta.app',
            type: 'PLATFORM',
            status: 'VERIFIED',
            isPrimary: true,
            verifiedAt: new Date(),
          },
        },
      },
    });

    // Dominio unverified per Venue A
    await prisma.venueDomain.create({
      data: {
        venueId: 'venue_a',
        hostname: 'unverified.sauta.app',
        type: 'CUSTOM',
        status: 'PENDING',
      },
    });

    // Dominio disabilitato per Venue A
    await prisma.venueDomain.create({
      data: {
        venueId: 'venue_a',
        hostname: 'disabled.sauta.app',
        type: 'CUSTOM',
        status: 'DISABLED',
      },
    });
  });

  it('1. risolve hostname con maiuscole, porte e trailing dot', async () => {
    const resUpper = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: { host: 'A.SAUTA.APP:443' },
    });
    expect(resUpper.statusCode).toBe(200);
    expect(resUpper.json()).toEqual({
      venue: { name: 'Venue Alpha', hostname: 'a.sauta.app' },
    });

    const resDot = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: { host: 'a.sauta.app.' },
    });
    expect(resDot.statusCode).toBe(200);
    expect(resDot.json()).toEqual({
      venue: { name: 'Venue Alpha', hostname: 'a.sauta.app' },
    });
  });

  it('2. restituisce 404 per host sconosciuto, malformato, unverified o disabilitato', async () => {
    const resUnknown = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: { host: 'unknown.sauta.app' },
    });
    expect(resUnknown.statusCode).toBe(404);

    const resUnverified = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: { host: 'unverified.sauta.app' },
    });
    expect(resUnverified.statusCode).toBe(404);

    const resDisabled = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: { host: 'disabled.sauta.app' },
    });
    expect(resDisabled.statusCode).toBe(404);

    const resMalformed = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: { host: 'https://a.sauta.app' },
    });
    expect(resMalformed.statusCode).toBe(404);
  });

  it('3. restituisce 404 per venue sospesa o inattiva', async () => {
    const resInactive = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: { host: 'c.sauta.app' },
    });
    expect(resInactive.statusCode).toBe(404);
  });

  it('4. isolamento multi-tenant: menu di A non restituisce prodotti di B', async () => {
    const resA = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current/menu',
      headers: { host: 'a.sauta.app' },
    });
    expect(resA.statusCode).toBe(200);
    const menuA = resA.json();
    expect(menuA.products).toHaveLength(1);
    expect(menuA.products[0].slug).toBe('mojito');

    const resB = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current/menu',
      headers: { host: 'b.sauta.app' },
    });
    expect(resB.statusCode).toBe(200);
    const menuB = resB.json();
    expect(menuB.products).toHaveLength(1);
    expect(menuB.products[0].slug).toBe('spritz');
  });

  it('5. checkout su host A con prodotti di B non crea sessioni o ticket di B', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'a.sauta.app' },
      payload: {
        totalAmount: 700,
        items: { spritz: 1 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(400);
    const sessionsCount = await prisma.checkoutSession.count({ where: { venueId: 'venue_b' } });
    expect(sessionsCount).toBe(0);
  });

  it('5b. checkout rifiuta venueId inviato dal client (additionalProperties: false)', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { host: 'a.sauta.app' },
      payload: {
        venueId: 'venue_b',
        totalAmount: 900,
        items: { mojito: 1 },
        digitalConsent: true,
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('6. richiesta senza Host header valido non fa fallback al dominio demo', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
    });
    expect(res.statusCode).toBe(404);
  });

  it('7. TRUST_PROXY=false ignora un forwarded host malevolo', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: {
        host: 'a.sauta.app',
        'x-forwarded-host': 'b.sauta.app',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().venue.name).toBe('Venue Alpha');
  });

  it('8. X-Forwarded-Host non altera l\'autorità dell\'Host (R5 fail-closed)', async () => {
    const resTrusted = await appTrustProxy.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: {
        host: 'internal-proxy.local',
        'x-forwarded-host': 'b.sauta.app',
      },
    });
    expect(resTrusted.statusCode).toBe(404);

    const resUntrustedForwarded = await appTrustProxy.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: {
        host: 'internal-proxy.local',
        'x-forwarded-host': 'malicious.unverified.app',
      },
    });
    expect(resUntrustedForwarded.statusCode).toBe(404);
  });

  it('9. GET /api/venue/current restituisce soltanto DTO minimo senza dati fiscali o credenziali', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: { host: 'a.sauta.app' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      venue: {
        name: 'Venue Alpha',
        hostname: 'a.sauta.app',
      },
    });
    expect(body.venue.stripeAccountId).toBeUndefined();
    expect(body.venue.acubeApiKey).toBeUndefined();
    expect(body.venue.acubeOrganizationId).toBeUndefined();
    expect(body.venue.vatNumber).toBeUndefined();
  });

  it('10. rotte Connect legacy rispondono 404 (non più pubblicamente sfruttabili)', async () => {
    const resRefresh = await app.fastify.inject({
      method: 'GET',
      url: '/api/connect/refresh/venue_a',
    });
    expect(resRefresh.statusCode).toBe(404);

    const resReturn = await app.fastify.inject({
      method: 'GET',
      url: '/api/connect/return/venue_a',
    });
    expect(resReturn.statusCode).toBe(404);
  });

  it('11. probe di selettività: /ping e /health NON eseguono query tenant', async () => {
    const spy = vi.spyOn(prisma.venueDomain, 'findFirst');

    const resPing = await app.fastify.inject({
      method: 'GET',
      url: '/ping',
    });
    expect(resPing.statusCode).toBe(200);

    const resHealth = await app.fastify.inject({
      method: 'GET',
      url: '/health',
    });
    expect(resHealth.statusCode).toBe(200);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('12. errore DB (Prisma) propaga 500 sanitizzato anziché mascherarlo come 404', async () => {
    const spy = vi.spyOn(prisma.venueDomain, 'findFirst').mockRejectedValueOnce(
      new Error('Prisma connection timeout error')
    );

    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/venue/current',
      headers: { host: 'a.sauta.app' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Errore interno del server' });

    spy.mockRestore();
  });

  it('13. isolamento ambiente di produzione: rifiuta .localhost con isProduction=true', async () => {
    const resolverProd = createTenantResolver({ prisma, isProduction: true });
    const resLocalhost = await resolverProd.resolveTenant('demo.localhost');
    expect(resLocalhost).toBeNull();
  });

  it('14. vincoli PostgreSQL check constraint su venue_domains', async () => {
    // 14.1 Hostname con slash (bad/path)
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO venue_domains (id, venue_id, hostname, type, status, created_at, updated_at) VALUES ('id_bad1', 'venue_a', 'bad/path', 'CUSTOM', 'PENDING', NOW(), NOW())`
      )
    ).rejects.toThrow();

    // 14.2 Hostname con porte o due punti (bad:port)
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO venue_domains (id, venue_id, hostname, type, status, created_at, updated_at) VALUES ('id_bad2', 'venue_a', 'bad:port', 'CUSTOM', 'PENDING', NOW(), NOW())`
      )
    ).rejects.toThrow();

    // 14.3 Gli IPv4 non sono hostname autorevoli validi
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO venue_domains (id, venue_id, hostname, type, status, created_at, updated_at) VALUES ('id_bad_ip', 'venue_a', '127.0.0.1', 'CUSTOM', 'PENDING', NOW(), NOW())`
      )
    ).rejects.toThrow();

    // 14.4 Hostname superante 253 caratteri
    const longHost = 'a'.repeat(250) + '.app';
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO venue_domains (id, venue_id, hostname, type, status, created_at, updated_at) VALUES ('id_bad3', 'venue_a', $1, 'CUSTOM', 'PENDING', NOW(), NOW())`,
        longHost
      )
    ).rejects.toThrow();

    // 14.5 Primary domain deve essere VERIFIED
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO venue_domains (id, venue_id, hostname, type, status, is_primary, created_at, updated_at) VALUES ('id_bad4', 'venue_a', 'primary-pending.sauta.app', 'CUSTOM', 'PENDING', true, NOW(), NOW())`
      )
    ).rejects.toThrow();

    // 14.6 Status VERIFIED deve contenere verified_at
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO venue_domains (id, venue_id, hostname, type, status, is_primary, verified_at, created_at, updated_at) VALUES ('id_bad5', 'venue_a', 'verified-nodaate.sauta.app', 'CUSTOM', 'VERIFIED', false, NULL, NOW(), NOW())`
      )
    ).rejects.toThrow();
  });
});
