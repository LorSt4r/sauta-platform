import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startTestDb } from '../db';
import { createTestApp } from '../helpers';
import { createFakeIdentityProvider } from '../../src/utils/identityProvider';

import { createPrismaClient } from '../../src/utils/prisma';

describe('Proxy Contract, Host Authority, CORS & Cache-Control Tests', () => {
  let prisma: PrismaClient;
  let stopPg: () => Promise<void>;

  beforeAll(async () => {
    const db = await startTestDb();
    prisma = createPrismaClient(db.url);
    stopPg = db.stop;
  }, 60000);

  afterAll(async () => {
    await stopPg?.();
  });

  it('rejects X-Forwarded-Host spoofing for tenant / console authority selection', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdP });

    const consoleRes = await app.fastify.inject({
      method: 'GET',
      url: '/console',
      headers: {
        host: 'unknown-spoof.com',
        'x-forwarded-host': 'console.sauta.test',
        forwarded: 'host=console.sauta.test;proto=https',
      },
    });

    expect(consoleRes.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 Not Found for unknown host header', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdP });

    for (const url of ['/', '/console', '/arbitrary-spa-route']) {
      const res = await app.fastify.inject({
        method: 'GET',
        url,
        headers: {
          host: 'malicious-domain.com',
        },
      });
      expect(res.statusCode).toBe(404);
    }
    await app.close();
  });

  it('serves PWA fallback only for a verified active tenant authority', async () => {
    const venue = await prisma.venue.create({
      data: { name: `Known Proxy Venue ${Date.now()}`, isActive: true },
    });
    const hostname = `known-${Date.now()}.sauta.test`;
    await prisma.venueDomain.create({
      data: {
        venueId: venue.id,
        hostname,
        type: 'PLATFORM',
        status: 'VERIFIED',
        isPrimary: true,
        verifiedAt: new Date(),
      },
    });
    const app = await createTestApp(prisma, {
      identityProvider: createFakeIdentityProvider(),
    });

    const root = await app.fastify.inject({
      method: 'GET',
      url: '/',
      headers: { host: hostname },
    });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toContain('text/html');
    await app.close();
  });

  it('includes PATCH method and exact origins in CORS headers', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdP });

    const res = await app.fastify.inject({
      method: 'OPTIONS',
      url: '/api/console/onboarding/profile',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        'access-control-request-method': 'PATCH',
      },
    });

    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    expect(res.headers['access-control-allow-origin']).toBe('http://console.localhost:3001');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    await app.close();
  });

  it('sets Cache-Control no-store on /api/** routes', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdP });

    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/auth/csrf',
      headers: {
        host: 'console.localhost:3001',
      },
    });

    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, proxy-revalidate');
    await app.close();
  });

  it('does not reflect unknown CORS origins', async () => {
    const app = await createTestApp(prisma, {
      identityProvider: createFakeIdentityProvider(),
    });
    const response = await app.fastify.inject({
      method: 'OPTIONS',
      url: '/api/console/onboarding/profile',
      headers: {
        host: 'console.localhost:3001',
        origin: 'https://attacker.example',
        'access-control-request-method': 'PATCH',
      },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    await app.close();
  });

  it('rejects TRUST_PROXY=true in production environment build', async () => {
    const prodConfig = {
      NODE_ENV: 'production',
      IS_PRODUCTION: true,
      TRUST_PROXY: true,
      STRIPE_API_KEY: 'sk_test_123',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_123',
      JWT_SECRET: '32chars_long_jwt_secret_test_key_123',
      TICKET_JWT_SECRET: '32chars_long_ticket_secret_key_123',
      DATABASE_URL: 'postgresql://localhost:5432/db',
      ADMIN_SECRET: '32chars_long_admin_secret_key_123',
      WORKOS_API_KEY: 'sk_test_wos',
      WORKOS_CLIENT_ID: 'client_wos',
      WORKOS_COOKIE_PASSWORD: '32chars_long_cookie_password_test_123',
      WORKOS_WEBHOOK_SECRET: 'whsec_wos',
      WORKOS_REDIRECT_URI: 'https://console.sauta.app/api/auth/callback',
      WORKOS_POST_LOGOUT_REDIRECT_URI: 'https://console.sauta.app',
      CONSOLE_ORIGIN: 'https://console.sauta.app',
      AUTH_AUDIT_HMAC_SECRET: '32chars_long_hmac_secret_key_12345',
      PLATFORM_ROOT_DOMAIN: 'sauta.app',
    };

    const dummyStripe: any = {};
    const dummyLogger: any = { info: () => {}, warn: () => {}, error: () => {} };

    await expect(
      createTestApp(prisma, {
        config: prodConfig as any,
        stripe: dummyStripe,
        logger: dummyLogger,
        identityProvider: createFakeIdentityProvider(),
      })
    ).rejects.toThrow('[CONFIG] TRUST_PROXY=true globale è rifiutato in produzione');
  });
});
