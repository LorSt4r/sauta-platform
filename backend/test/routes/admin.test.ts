import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { startTestDb, type TestDbHandle } from '../db';
import { registerAdminRoutes, checkAdminAuth } from '../../src/routes/admin';
import { createConfig, type AppConfig } from '../../src/utils/config';
import { prisma as globalPrisma } from '../../src/utils/prisma';
import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';

const ADMIN_SECRET = 'test-admin-secret-32chars-aaaaaaaaaaaaaa';

/**
 * Mock Stripe per test admin/onboarding.
 * Ritorna oggetti finti per accounts.create, accountLinks.create, accounts.retrieve.
 */
function createMockStripe(): Partial<Stripe> {
  return {
    accounts: {
      create: vi.fn(async (params: any) => ({
        id: 'acct_test_' + Math.random().toString(36).substring(2, 18),
        type: params.type,
        country: params.country,
        email: params.email,
        capabilities: params.capabilities,
        business_type: params.business_type,
        charges_enabled: false,
        payouts_enabled: false,
      })) as any,
      retrieve: vi.fn(async (id: string) => ({
        id,
        charges_enabled: true,
        payouts_enabled: true,
        requirements: { currently_due: [], past_due: [] },
      })) as any,
    } as any,
    accountLinks: {
      create: vi.fn(async (params: any) => ({
        object: 'account_link',
        created: Date.now(),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        url: `https://connect.stripe.com/setup/e/${params.account}`,
        type: params.type,
      })) as any,
    } as any,
  } as Partial<Stripe>;
}

describe('Admin endpoints [FIX 3.1, 3.5]', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;
  let fastify: any;
  let mockStripe: Partial<Stripe>;
  let cfg: AppConfig;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
    await prisma.$connect();
    mockStripe = createMockStripe();

    cfg = createConfig({
      STRIPE_SECRET_KEY: 'sk_test_mock',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_mock',
      STRIPE_WEBHOOK_SECRET: 'whsec_mock',
      STRIPE_CLIENT_ID: 'ca_test_mock',
      JWT_SECRET: process.env.JWT_SECRET!,
      TICKET_JWT_SECRET: process.env.TICKET_JWT_SECRET!,
      DATABASE_URL: process.env.DATABASE_URL!,
      NODE_ENV: 'test',
      PORT: '3001',
      BASE_URL: 'http://localhost:3001',
      ALLOWED_ORIGINS: 'http://localhost:5173',
      ADMIN_SECRET,
      WORKOS_API_KEY: 'sk_test_workos_admin_routes',
      WORKOS_CLIENT_ID: 'client_workos_admin_routes',
      WORKOS_COOKIE_PASSWORD: 'test-workos-cookie-password-32-chars-admin',
      WORKOS_WEBHOOK_SECRET: 'whsec_workos_admin_routes',
      WORKOS_REDIRECT_URI: 'http://console.localhost:3001/api/auth/callback',
      WORKOS_POST_LOGOUT_REDIRECT_URI: 'http://console.localhost:3001',
      CONSOLE_ORIGIN: 'http://console.localhost:3001',
      PLATFORM_ROOT_DOMAIN: 'sauta.test',
      AUTH_AUDIT_HMAC_SECRET: 'test-auth-audit-hmac-secret-32-chars-admin',
    });

    fastify = Fastify({ trustProxy: true, logger: false });
    await fastify.register(rawBody, { runFirst: true });
    await fastify.register(registerAdminRoutes, { prisma, stripe: mockStripe as Stripe, config: cfg });
  }, 60000);

  afterAll(async () => {
    await fastify?.close();
    await prisma?.$disconnect();
    await db?.stop();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    await prisma.fiscalLog.deleteMany();
    await prisma.ticket.deleteMany();
    await prisma.checkoutSession.deleteMany();
    await prisma.product.deleteMany();
    await prisma.venue.deleteMany();

    await prisma.venue.create({
      data: { id: 'v1', name: 'Test Disco' },
    });
  });

  describe('checkAdminAuth', () => {
    it('ritorna true per secret corretto', () => {
      const mockReq = { headers: { 'x-admin-secret': ADMIN_SECRET } } as any;
      expect(checkAdminAuth(mockReq, ADMIN_SECRET)).toBe(true);
    });

    it('ritorna false per secret sbagliato', () => {
      const mockReq = { headers: { 'x-admin-secret': 'wrong' } } as any;
      expect(checkAdminAuth(mockReq, ADMIN_SECRET)).toBe(false);
    });

    it('ritorna false per header mancante', () => {
      const mockReq = { headers: {} } as any;
      expect(checkAdminAuth(mockReq, ADMIN_SECRET)).toBe(false);
    });
  });

  describe('POST /api/onboard-venue', () => {
    it('rifiuta senza X-Admin-Secret (401)', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/onboard-venue',
        payload: { venueId: 'v1' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rifiuta venueId mancante (400)', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/onboard-venue',
        headers: { 'x-admin-secret': ADMIN_SECRET },
        payload: { email: 'test@example.com' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rifiuta venue non trovato (404)', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/onboard-venue',
        headers: { 'x-admin-secret': ADMIN_SECRET },
        payload: { venueId: 'nonexistent' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('rifiuta venue già onboardato (409)', async () => {
      await prisma.venue.update({
        where: { id: 'v1' },
        data: { stripeAccountId: 'acct_existing123456789' },
      });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/onboard-venue',
        headers: { 'x-admin-secret': ADMIN_SECRET },
        payload: { venueId: 'v1' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('creates account with businessType "individual"', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/onboard-venue',
        headers: { 'x-admin-secret': ADMIN_SECRET },
        payload: { venueId: 'v1', businessType: 'individual' },
      });
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(mockStripe.accounts!.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          business_type: 'individual',
        })
      );
    });

    it('creates account with businessType "company"', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/onboard-venue',
        headers: { 'x-admin-secret': ADMIN_SECRET },
        payload: { venueId: 'v1', businessType: 'company' },
      });
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(mockStripe.accounts!.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          business_type: 'company',
        })
      );
    });

    it('creates account with default businessType "company" if omitted', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/onboard-venue',
        headers: { 'x-admin-secret': ADMIN_SECRET },
        payload: { venueId: 'v1' },
      });
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(mockStripe.accounts!.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          business_type: 'company',
        })
      );
    });

    it('rejects invalid businessType with 400', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/onboard-venue',
        headers: { 'x-admin-secret': ADMIN_SECRET },
        payload: { venueId: 'v1', businessType: 'invalid' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('businessType non valido. Deve essere "individual" o "company"');
    });

    it('rejects invalid businessType "" with 400', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/onboard-venue',
        headers: { 'x-admin-secret': ADMIN_SECRET },
        payload: { venueId: 'v1', businessType: '' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('businessType non valido. Deve essere "individual" o "company"');
    });

    it('rejects invalid businessType false with 400', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/onboard-venue',
        headers: { 'x-admin-secret': ADMIN_SECRET },
        payload: { venueId: 'v1', businessType: false },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('businessType non valido. Deve essere "individual" o "company"');
    });

    it('rejects invalid businessType null with 400', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/onboard-venue',
        headers: { 'x-admin-secret': ADMIN_SECRET },
        payload: { venueId: 'v1', businessType: null },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('businessType non valido. Deve essere "individual" o "company"');
    });
  });

  describe('GET /api/admin/venues', () => {
    it('rifiuta senza X-Admin-Secret (401)', async () => {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/admin/venues',
      });
      expect(res.statusCode).toBe(401);
    });

    it('ritorna lista venue con stato Stripe', async () => {
      await prisma.venue.update({
        where: { id: 'v1' },
        data: {
          stripeAccountId: 'acct_test123456789012',
          stripeChargesEnabled: true,
          stripePayoutsEnabled: true,
          applicationFeePercent: 3.5,
        },
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/admin/venues',
        headers: { 'x-admin-secret': ADMIN_SECRET },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.venues.length).toBe(1);
      expect(body.venues[0].stripeChargesEnabled).toBe(true);
      expect(body.venues[0].applicationFeePercent).toBe(3.5);
    });
  });

  describe('POST /api/admin/venues/:id/refresh-link', () => {
    it('rifiuta venue non ancora onboardato (400)', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/admin/venues/v1/refresh-link',
        headers: { 'x-admin-secret': ADMIN_SECRET },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rifiuta venue non trovato (404)', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/admin/venues/nonexistent/refresh-link',
        headers: { 'x-admin-secret': ADMIN_SECRET },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('Public Connect Redirects (Legacy - Removed in 9C.0A)', () => {
    it('GET /api/connect/refresh/:venueId ritorna 404 (route pubblica rimossa)', async () => {
      await prisma.venue.update({
        where: { id: 'v1' },
        data: { stripeAccountId: 'acct_test123456' },
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/connect/refresh/v1',
      });

      expect(res.statusCode).toBe(404);
    });

    it('GET /api/connect/return/:venueId ritorna 404 (route pubblica rimossa)', async () => {
      await prisma.venue.update({
        where: { id: 'v1' },
        data: { stripeAccountId: 'acct_test123456' },
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/connect/return/v1',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
