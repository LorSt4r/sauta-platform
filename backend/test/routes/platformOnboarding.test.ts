import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startTestDb } from '../db';
import { createTestApp } from '../helpers';
import { createFakeIdentityProvider } from '../../src/utils/identityProvider';

import { createPrismaClient } from '../../src/utils/prisma';

describe('Platform Onboarding Routes (/api/platform/**)', () => {
  let prisma: PrismaClient;
  let stopPg: () => Promise<void>;
  let fakeIdP: ReturnType<typeof createFakeIdentityProvider>;

  beforeAll(async () => {
    const db = await startTestDb();
    prisma = createPrismaClient(db.url);
    stopPg = db.stop;
    fakeIdP = createFakeIdentityProvider();
  }, 60000);

  afterAll(async () => {
    await stopPg?.();
  });

  const getAuthCookies = async (app: any, idP: any, userRole: 'PLATFORM_ADMIN' | 'NONE') => {
    const user = await prisma.platformUser.create({
      data: {
        workosUserId: `wos_usr_${Date.now()}_${Math.random()}`,
        emailNormalized: `admin_${Date.now()}@sauta.test`,
        status: 'ACTIVE',
        platformRole: userRole,
      },
    });

    const sealedSession = `sealed_session_sess_${Date.now()}_${Math.random()}`;
    idP.sessions.set(sealedSession, {
      sessionId: `sess_${Date.now()}`,
      userId: user.workosUserId!,
      email: user.emailNormalized,
      emailVerified: true,
    });

    const csrfRes = await app.fastify.inject({
      method: 'GET',
      url: '/api/auth/csrf',
      headers: { host: 'console.localhost:3001' },
    });
    const csrfToken = JSON.parse(csrfRes.payload).csrfToken;
    const csrfCookieHeader = csrfRes.headers['set-cookie'];

    const signedSession = app.fastify.signCookie(sealedSession);
    const sessionCookieHeader = `wos_session=${signedSession}`;
    const cookieHeader = [
      Array.isArray(csrfCookieHeader) ? csrfCookieHeader[0] : csrfCookieHeader,
      sessionCookieHeader,
    ].join('; ');

    return { user, cookieHeader, csrfToken };
  };

  it('allows PLATFORM_ADMIN to create draft venue with server-side platform domain and onboarding steps', async () => {
    const fakeIdPLocal = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdPLocal });

    const { cookieHeader, csrfToken } = await getAuthCookies(app, fakeIdPLocal, 'PLATFORM_ADMIN');
    const slug = `venue-${Date.now()}`;

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/platform/venues',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': `key_create_${slug}`,
      },
      payload: {
        name: 'Test Venue Platform',
        slug,
        ownerEmail: `owner_${slug}@sauta.test`,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.venueId).toBeDefined();
    expect(body.hostname).toBe(`${slug}.sauta.test`);
    expect(body.onboardingStatus).toBe('DRAFT');

    // Verify DB records
    const venue = await prisma.venue.findUnique({
      where: { id: body.venueId },
      include: { onboarding: true, onboardingSteps: true, domains: true, invitations: true },
    });
    expect(venue?.isActive).toBe(false);
    expect(venue?.onboarding?.status).toBe('IN_PROGRESS');
    expect(venue?.onboardingSteps).toHaveLength(7);
    expect(venue?.domains[0].hostname).toBe(`${slug}.sauta.test`);
    expect(venue?.invitations[0].invitedEmailNormalized).toBe(`owner_${slug}@sauta.test`);

    const details = await app.fastify.inject({
      method: 'GET',
      url: `/api/platform/venues/${body.venueId}/onboarding`,
      headers: {
        host: 'console.localhost:3001',
        cookie: cookieHeader,
      },
    });
    expect(details.statusCode).toBe(200);
    expect(Object.keys(details.json().storedSteps[0]).sort()).toEqual([
      'completedAt',
      'reasonCode',
      'source',
      'status',
      'step',
    ]);
    expect(Object.keys(details.json().domains[0]).sort()).toEqual([
      'hostname',
      'isPrimary',
      'status',
      'type',
      'verifiedAt',
    ]);
    expect(JSON.stringify(details.json())).not.toContain(
      'accept_invitation_url'
    );

    await app.close();
  });

  it('handles Idempotency-Key duplication and payload mismatch conflict', async () => {
    const fakeIdPLocal = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdPLocal });
    const { cookieHeader, csrfToken } = await getAuthCookies(app, fakeIdPLocal, 'PLATFORM_ADMIN');
    const slug = `idem-${Date.now()}`;
    const idempotencyKey = `key_idem_${Date.now()}`;

    // First request
    const res1 = await app.fastify.inject({
      method: 'POST',
      url: '/api/platform/venues',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': idempotencyKey,
      },
      payload: { name: 'Idem Venue', slug, ownerEmail: `owner_${slug}@sauta.test` },
    });
    expect(res1.statusCode).toBe(201);

    // Second request with SAME payload -> returns 200/201 replay
    const res2 = await app.fastify.inject({
      method: 'POST',
      url: '/api/platform/venues',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': idempotencyKey,
      },
      payload: { name: 'Idem Venue', slug, ownerEmail: `owner_${slug}@sauta.test` },
    });
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.payload).idempotentReplay).toBe(true);

    // Third request with SAME key but DIFFERENT payload -> returns 409 Conflict
    const res3 = await app.fastify.inject({
      method: 'POST',
      url: '/api/platform/venues',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': idempotencyKey,
      },
      payload: { name: 'Different Name', slug, ownerEmail: `owner_${slug}@sauta.test` },
    });
    expect(res3.statusCode).toBe(409);
    expect(JSON.parse(res3.payload).reasonCode).toBe('idempotency_key_payload_mismatch');

    await app.close();
  });

  it('deduplicates concurrent create requests at the database boundary', async () => {
    const fakeIdPLocal = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdPLocal });
    const { cookieHeader, csrfToken } = await getAuthCookies(
      app,
      fakeIdPLocal,
      'PLATFORM_ADMIN'
    );
    const slug = `concurrent-${Date.now()}`;
    const request = {
      method: 'POST' as const,
      url: '/api/platform/venues',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': `key_concurrent_${slug}`,
      },
      payload: {
        name: 'Concurrent Venue',
        slug,
        ownerEmail: `owner_${slug}@sauta.test`,
      },
    };

    const responses = await Promise.all([
      app.fastify.inject(request),
      app.fastify.inject(request),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 201,
    ]);
    expect(
      await prisma.venueDomain.count({
        where: { hostname: `${slug}.sauta.test` },
      })
    ).toBe(1);
    expect(fakeIdPLocal.organizationCreateRequests).toHaveLength(1);
    await app.close();
  });

  it('denies missing exact Origin CSRF and non-platform callers', async () => {
    const fakeIdPLocal = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdPLocal });
    const admin = await getAuthCookies(
      app,
      fakeIdPLocal,
      'PLATFORM_ADMIN'
    );
    const slug = `csrf-denied-${Date.now()}`;
    const missingOrigin = await app.fastify.inject({
      method: 'POST',
      url: '/api/platform/venues',
      headers: {
        host: 'console.localhost:3001',
        cookie: admin.cookieHeader,
        'x-csrf-token': admin.csrfToken,
        'idempotency-key': `key_${slug}`,
      },
      payload: {
        name: 'Denied Venue',
        slug,
        ownerEmail: `owner_${slug}@sauta.test`,
      },
    });
    expect(missingOrigin.statusCode).toBe(403);

    const regular = await getAuthCookies(app, fakeIdPLocal, 'NONE');
    const nonPlatform = await app.fastify.inject({
      method: 'POST',
      url: '/api/platform/venues',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: regular.cookieHeader,
        'x-csrf-token': regular.csrfToken,
        'idempotency-key': `key_regular_${slug}`,
      },
      payload: {
        name: 'Denied Venue',
        slug,
        ownerEmail: `owner_${slug}@sauta.test`,
      },
    });
    expect(nonPlatform.statusCode).toBe(403);
    expect(
      await prisma.venueDomain.findUnique({
        where: { hostname: `${slug}.sauta.test` },
      })
    ).toBeNull();
    await app.close();
  });

  it('applies the selective platform mutation rate limit', async () => {
    const fakeIdPLocal = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdPLocal });
    const admin = await getAuthCookies(
      app,
      fakeIdPLocal,
      'PLATFORM_ADMIN'
    );
    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(
        await app.fastify.inject({
          method: 'POST',
          url: '/api/platform/venues',
          headers: {
            host: 'console.localhost:3001',
            cookie: admin.cookieHeader,
            'x-csrf-token': admin.csrfToken,
            'idempotency-key': `rate_limit_${index}`,
          },
          payload: {
            name: 'Rate Limited',
            slug: `rate-limited-${index}`,
            ownerEmail: `rate-${index}@sauta.test`,
          },
        })
      );
    }
    expect(responses.slice(0, 10).every((response) => response.statusCode === 403)).toBe(true);
    expect(responses[10]?.statusCode).toBe(429);
    await app.close();
  });

  it('denies venue activation fail-closed for new venues missing STRIPE or FISCAL', async () => {
    const fakeIdPLocal = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdPLocal });
    const { cookieHeader, csrfToken } = await getAuthCookies(app, fakeIdPLocal, 'PLATFORM_ADMIN');
    const slug = `act-deny-${Date.now()}`;

    const createRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/platform/venues',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': `key_${slug}`,
      },
      payload: { name: 'Activation Denied Venue', slug, ownerEmail: `owner_${slug}@sauta.test` },
    });
    const venueId = JSON.parse(createRes.payload).venueId;

    // Attempt activation
    const actRes = await app.fastify.inject({
      method: 'POST',
      url: `/api/platform/venues/${venueId}/activate`,
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': `key_act_${slug}`,
      },
    });

    expect(actRes.statusCode).toBe(400);
    const body = JSON.parse(actRes.payload);
    expect(body.eligible).toBe(false);
    expect(body.missingSteps).toContain('STRIPE');
    expect(body.missingSteps).toContain('FISCAL');

    const venue = await prisma.venue.findUnique({ where: { id: venueId } });
    expect(venue?.isActive).toBe(false);

    await app.close();
  });

  it('allows platform admin to review LEGAL and OPERATIONS steps', async () => {
    const fakeIdPLocal = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdPLocal });
    const { cookieHeader, csrfToken } = await getAuthCookies(app, fakeIdPLocal, 'PLATFORM_ADMIN');
    const slug = `rev-${Date.now()}`;

    const createRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/platform/venues',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': `key_${slug}`,
      },
      payload: { name: 'Review Venue', slug, ownerEmail: `owner_${slug}@sauta.test` },
    });
    const venueId = JSON.parse(createRes.payload).venueId;
    await prisma.venue.update({
      where: { id: venueId },
      data: {
        vatNumber: 'IT12345678901',
        fiscalAddress: 'Via Test 1',
        fiscalCity: 'Roma',
        fiscalZip: '00100',
      },
    });

    const revRes = await app.fastify.inject({
      method: 'PATCH',
      url: `/api/platform/venues/${venueId}/onboarding/review`,
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': `key_rev_${slug}`,
      },
      payload: { step: 'LEGAL', status: 'READY' },
    });

    expect(revRes.statusCode).toBe(200);
    const step = await prisma.venueOnboardingStep.findUnique({
      where: { venueId_step: { venueId, step: 'LEGAL' } },
    });
    expect(step?.status).toBe('READY');
    expect(step?.source).toBe('PLATFORM_REVIEW');

    await app.close();
  });

  it('resends and revokes the exact OWNER invitation with durable replay', async () => {
    const fakeIdPLocal = createFakeIdentityProvider();
    const app = await createTestApp(prisma, { identityProvider: fakeIdPLocal });
    const { cookieHeader, csrfToken } = await getAuthCookies(
      app,
      fakeIdPLocal,
      'PLATFORM_ADMIN'
    );
    const slug = `invite-actions-${Date.now()}`;
    const created = await app.fastify.inject({
      method: 'POST',
      url: '/api/platform/venues',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': `key_create_${slug}`,
      },
      payload: {
        name: 'Invitation Actions Venue',
        slug,
        ownerEmail: `owner_${slug}@sauta.test`,
      },
    });
    expect(created.statusCode).toBe(201);
    const venueId = created.json().venueId as string;
    const invitation = await prisma.venueInvitation.findFirstOrThrow({
      where: { venueId },
    });
    expect(invitation.status).toBe('SENT');

    const resendHeaders = {
      host: 'console.localhost:3001',
      origin: 'http://console.localhost:3001',
      cookie: cookieHeader,
      'x-csrf-token': csrfToken,
      'idempotency-key': `key_resend_${slug}`,
    };
    const resent = await app.fastify.inject({
      method: 'POST',
      url: `/api/platform/invitations/${invitation.id}/resend`,
      headers: resendHeaders,
    });
    expect(resent.statusCode).toBe(200);
    const replayedResend = await app.fastify.inject({
      method: 'POST',
      url: `/api/platform/invitations/${invitation.id}/resend`,
      headers: resendHeaders,
    });
    expect(replayedResend.statusCode).toBe(200);
    expect(replayedResend.json().idempotentReplay).toBe(true);
    expect(fakeIdPLocal.invitationResendRequests).toEqual([
      invitation.workosInvitationId,
    ]);

    const revokeHeaders = {
      host: 'console.localhost:3001',
      origin: 'http://console.localhost:3001',
      cookie: cookieHeader,
      'x-csrf-token': csrfToken,
      'idempotency-key': `key_revoke_${slug}`,
    };
    const revoked = await app.fastify.inject({
      method: 'POST',
      url: `/api/platform/invitations/${invitation.id}/revoke`,
      headers: revokeHeaders,
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      (await prisma.venueInvitation.findUnique({
        where: { id: invitation.id },
      }))?.status
    ).toBe('REVOKED');
    const replayedRevoke = await app.fastify.inject({
      method: 'POST',
      url: `/api/platform/invitations/${invitation.id}/revoke`,
      headers: revokeHeaders,
    });
    expect(replayedRevoke.statusCode).toBe(200);
    expect(replayedRevoke.json().idempotentReplay).toBe(true);
    expect(fakeIdPLocal.invitationRevokeRequests).toEqual([
      invitation.workosInvitationId,
    ]);
    await app.close();
  });

  it('retries only a RETRYABLE command through an explicit idempotent platform action', async () => {
    const baseProvider = createFakeIdentityProvider();
    const originalCreateOrganization =
      baseProvider.createOrganization.bind(baseProvider);
    let providerAvailable = false;
    const provider = {
      ...baseProvider,
      async createOrganization(
        opts: Parameters<typeof baseProvider.createOrganization>[0]
      ) {
        if (!providerAvailable) {
          throw new Error('synthetic_provider_unavailable');
        }
        return originalCreateOrganization(opts);
      },
    };
    const app = await createTestApp(prisma, { identityProvider: provider });
    const { cookieHeader, csrfToken } = await getAuthCookies(
      app,
      provider,
      'PLATFORM_ADMIN'
    );
    const slug = `retry-command-${Date.now()}`;
    const created = await app.fastify.inject({
      method: 'POST',
      url: '/api/platform/venues',
      headers: {
        host: 'console.localhost:3001',
        origin: 'http://console.localhost:3001',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': `key_create_${slug}`,
      },
      payload: {
        name: 'Retry Command Venue',
        slug,
        ownerEmail: `owner_${slug}@sauta.test`,
      },
    });
    expect(created.statusCode).toBe(201);
    const commandId = created.json().provisioningCommandId as string;
    expect(
      (await prisma.identityProvisioningCommand.findUnique({
        where: { id: commandId },
      }))?.status
    ).toBe('RETRYABLE');

    providerAvailable = true;
    const retryHeaders = {
      host: 'console.localhost:3001',
      origin: 'http://console.localhost:3001',
      cookie: cookieHeader,
      'x-csrf-token': csrfToken,
      'idempotency-key': `key_retry_${slug}`,
    };
    const retried = await app.fastify.inject({
      method: 'POST',
      url: `/api/platform/provisioning/${commandId}/retry`,
      headers: retryHeaders,
    });
    expect(retried.statusCode).toBe(202);
    expect(
      (await prisma.identityProvisioningCommand.findUnique({
        where: { id: commandId },
      }))?.status
    ).toBe('SUCCEEDED');

    const replayed = await app.fastify.inject({
      method: 'POST',
      url: `/api/platform/provisioning/${commandId}/retry`,
      headers: retryHeaders,
    });
    expect(replayed.statusCode).toBe(202);
    expect(replayed.json().idempotentReplay).toBe(true);
    expect(baseProvider.organizationCreateRequests).toHaveLength(1);
    await app.close();
  });
});
