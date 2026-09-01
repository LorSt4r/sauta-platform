import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startTestDb } from '../db';
import { createTestApp } from '../helpers';
import { createFakeIdentityProvider } from '../../src/utils/identityProvider';

import { createPrismaClient } from '../../src/utils/prisma';

describe('Console Onboarding Routes (/api/console/onboarding**)', () => {
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

  const setupOwnerSessionForInactiveVenue = async (fakeIdP: any, app: any) => {
    const slug = `owner-onb-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const venue = await prisma.venue.create({
      data: {
        name: 'Pre-Activation Owner Venue',
        isActive: false,
        workosOrganizationId: `org_${slug}`,
      },
    });

    await prisma.venueDomain.create({
      data: {
        venueId: venue.id,
        hostname: `${slug}.sauta.test`,
        type: 'PLATFORM',
        status: 'VERIFIED',
        isPrimary: true,
        verifiedAt: new Date(),
      },
    });

    await prisma.venueOnboarding.create({
      data: { venueId: venue.id, status: 'IN_PROGRESS' },
    });

    const user = await prisma.platformUser.create({
      data: {
        workosUserId: `wos_owner_${slug}`,
        emailNormalized: `owner_${slug}@sauta.test`,
        status: 'ACTIVE',
      },
    });

    const membership = await prisma.venueMembership.create({
      data: {
        userId: user.id,
        venueId: venue.id,
        role: 'OWNER',
        status: 'ACTIVE',
      },
    });

    const sealedSession = `sealed_session_owner_${slug}`;
    fakeIdP.sessions.set(sealedSession, {
      sessionId: `sess_owner_${slug}`,
      userId: user.workosUserId!,
      email: user.emailNormalized,
      emailVerified: true,
      organizationId: venue.workosOrganizationId!,
    });

    const csrfRes = await app.fastify.inject({
      method: 'GET',
      url: '/api/auth/csrf',
      headers: { host: 'console.localhost:3001' },
    });
    const csrfToken = JSON.parse(csrfRes.payload).csrfToken;
    const csrfCookieHeader = csrfRes.headers['set-cookie'];

    const signedSession = app.fastify.signCookie(sealedSession);
    const cookieHeader = [
      Array.isArray(csrfCookieHeader) ? csrfCookieHeader[0] : csrfCookieHeader,
      `wos_session=${signedSession}`,
    ].join('; ');

    return { venue, user, membership, cookieHeader, csrfToken, slug };
  };

  it('allows active OWNER pre-activation access to GET /api/console/onboarding', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdP });

    const { venue, cookieHeader } = await setupOwnerSessionForInactiveVenue(fakeIdP, app);

    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/console/onboarding',
      headers: {
        host: 'console.localhost:3001',
        cookie: cookieHeader,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.venue.id).toBe(venue.id);
    expect(body.venue.isActive).toBe(false);
    expect(body.onboardingStatus).toBe('IN_PROGRESS');

    await app.close();
  });

  it('allows active OWNER to update allowlisted profile fields via PATCH /api/console/onboarding/profile', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdP });

    const { venue, cookieHeader, csrfToken } = await setupOwnerSessionForInactiveVenue(fakeIdP, app);

    const res = await app.fastify.inject({
      method: 'PATCH',
      url: '/api/console/onboarding/profile',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
      },
      payload: {
        name: 'Updated Venue Name',
        vatNumber: 'IT12345678901',
        fiscalAddress: 'Via Roma 10',
        fiscalCity: 'Milano',
        fiscalZip: '20121',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.venue.name).toBe('Updated Venue Name');
    expect(body.venue.vatNumber).toBe('IT12345678901');

    const updatedVenue = await prisma.venue.findUnique({ where: { id: venue.id } });
    expect(updatedVenue?.fiscalCity).toBe('Milano');

    await app.close();
  });

  it('strictly denies inactive venue access on business routes via venueGuard', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdP });

    const { cookieHeader } = await setupOwnerSessionForInactiveVenue(fakeIdP, app);

    // GET /api/console/venue uses venueGuard which requires isActive = true!
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/console/venue',
      headers: {
        host: 'console.localhost:3001',
        cookie: cookieHeader,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).reasonCode).toBe('venue_not_found');

    await app.close();
  });

  it('fails closed when the onboarding aggregate is missing', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdP });
    const { venue, cookieHeader } = await setupOwnerSessionForInactiveVenue(
      fakeIdP,
      app
    );
    await prisma.venueOnboarding.delete({ where: { venueId: venue.id } });

    const response = await app.fastify.inject({
      method: 'GET',
      url: '/api/console/onboarding',
      headers: {
        host: 'console.localhost:3001',
        cookie: cookieHeader,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().reasonCode).toBe('onboarding_not_initialized');
    await app.close();
  });

  it('rejects non-allowlisted profile fields without partial updates', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdP });
    const { venue, cookieHeader, csrfToken } =
      await setupOwnerSessionForInactiveVenue(fakeIdP, app);

    const response = await app.fastify.inject({
      method: 'PATCH',
      url: '/api/console/onboarding/profile',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
      },
      payload: {
        name: 'Should Not Persist',
        stripeChargesEnabled: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(
      (await prisma.venue.findUnique({ where: { id: venue.id } }))?.name
    ).toBe('Pre-Activation Owner Venue');
    await app.close();
  });

  it('does not infer STRIPE or FISCAL readiness from legacy venue columns', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdP });
    const { venue, cookieHeader } = await setupOwnerSessionForInactiveVenue(
      fakeIdP,
      app
    );
    await prisma.venue.update({
      where: { id: venue.id },
      data: {
        stripeAccountId: `acct_legacy_${Date.now()}`,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
        acubeOrganizationId: `acube_legacy_${Date.now()}`,
        acubeApiKey: 'legacy_key_not_a_provider_snapshot',
      },
    });

    const response = await app.fastify.inject({
      method: 'GET',
      url: '/api/console/onboarding',
      headers: {
        host: 'console.localhost:3001',
        cookie: cookieHeader,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().readiness.missingSteps).toEqual(
      expect.arrayContaining(['STRIPE', 'FISCAL'])
    );
    await app.close();
  });
});
