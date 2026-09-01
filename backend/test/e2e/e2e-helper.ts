import { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb } from '../db';
import { createTestApp, type TestApp } from '../helpers';
import Stripe from 'stripe';
import { createPrismaClient } from '../../src/utils/prisma';
import type { IdentityProvider } from '../../src/utils/identityProvider';

let app: TestApp | null = null;
let prisma: PrismaClient | null = null;
let port: number | null = null;

// Mock Stripe helper for offline E2E runs
export function createMockStripe(): any {
  return {
    accounts: {
      create: async (params: any) => ({
        id: 'acct_mock_' + Math.random().toString(36).substring(2, 10),
        type: params.type,
        country: params.country,
        email: params.email,
        capabilities: params.capabilities,
        business_type: params.business_type,
        charges_enabled: true,
        payouts_enabled: true,
      }),
      retrieve: async (id: string) => ({
        id,
        charges_enabled: true,
        payouts_enabled: true,
        requirements: { currently_due: [], past_due: [] },
      }),
    },
    accountLinks: {
      create: async (params: any) => ({
        object: 'account_link',
        created: Date.now(),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        url: `https://connect.stripe.com/setup/e/${params.account}`,
        type: params.type,
      }),
    },
    paymentIntents: {
      create: async (params: any) => ({
        id: 'pi_mock_' + Math.random().toString(36).substring(2, 10),
        client_secret: 'pi_mock_secret_' + Math.random().toString(36).substring(2, 10),
        amount: params.amount,
        currency: params.currency,
        status: 'requires_payment_method',
        metadata: params.metadata,
      }),
      retrieve: async (id: string) => ({
        id,
        amount: 1000,
        currency: 'eur',
        status: 'succeeded',
        metadata: { sessionId: id.replace('mock_', ''), venueId: 'venue-id' },
      }),
    },
    webhooks: {
      constructEvent: (body: any, signature: string, secret: string) => {
        if (!signature || signature.startsWith('invalid')) {
          throw new Error('Webhook signature verification failed');
        }
        try {
          return typeof body === 'string' ? JSON.parse(body) : body;
        } catch {
          return body;
        }
      },
    },
  };
}

export async function setupE2eTest(opts?: { identityProvider?: IdentityProvider }) {
  const db = await startTestDb();

  prisma = createPrismaClient(db.url);

  // Set database url in process env so prisma internally uses the test container
  process.env.DATABASE_URL = db.url;

  const mockStripe = createMockStripe();

  app = await createTestApp(prisma, {
    stripe: mockStripe,
    identityProvider: opts?.identityProvider,
    config: {
      DATABASE_URL: db.url,
    },
  });

  await app.fastify.listen({ port: 0, host: '0.0.0.0' });

  const address = app.fastify.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server address not found or not an object');
  }

  port = address.port;

  // Le route CSRF richiedono equality esatta dell'Origin. Il server E2E usa
  // una porta effimera, quindi allineiamo i tre URI della console dopo listen.
  const consoleOrigin = `http://console.localhost:${port}`;
  app.config.CONSOLE_ORIGIN = consoleOrigin;
  app.config.WORKOS_REDIRECT_URI = `${consoleOrigin}/api/auth/callback`;
  app.config.WORKOS_POST_LOGOUT_REDIRECT_URI = consoleOrigin;

  // Seed venue_demo_1 e dominio demo.localhost per E2E PWA
  const venue1 = await prisma.venue.upsert({
    where: { id: 'venue_demo_1' },
    update: { name: 'Demo Sauta Cloud (A-Cube)', isActive: true, workosOrganizationId: 'org_e2e_alpha' },
    create: { id: 'venue_demo_1', name: 'Demo Sauta Cloud (A-Cube)', isActive: true, workosOrganizationId: 'org_e2e_alpha' },
  });

  await prisma.venueDomain.upsert({
    where: { hostname: 'demo.localhost' },
    update: { venueId: venue1.id, type: 'PLATFORM', status: 'VERIFIED', isPrimary: true, verifiedAt: new Date() },
    create: { venueId: venue1.id, hostname: 'demo.localhost', type: 'PLATFORM', status: 'VERIFIED', isPrimary: true, verifiedAt: new Date() },
  });

  return {
    app,
    prisma,
    baseUrl: getBaseUrl(),
  };
}

export async function createE2eVenue(prisma: PrismaClient, data: any = {}) {
  const venue = await prisma.venue.create({
    data: {
      name: 'E2E Venue',
      isActive: true,
      ...data,
    },
  });

  await prisma.venueDomain.upsert({
    where: { hostname: 'demo.localhost' },
    update: {
      venueId: venue.id,
      status: 'VERIFIED',
      isPrimary: true,
      verifiedAt: new Date(),
    },
    create: {
      venueId: venue.id,
      hostname: 'demo.localhost',
      type: 'PLATFORM',
      status: 'VERIFIED',
      isPrimary: true,
      verifiedAt: new Date(),
    },
  });

  return venue;
}

export function getBaseUrl(): string {
  if (!port) {
    throw new Error('E2E server is not running');
  }
  return `http://demo.localhost:${port}`;
}

export async function cleanupE2eTest() {
  if (app) {
    await app.close();
    app = null;
  }
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
  await stopTestDb();
  port = null;
}
