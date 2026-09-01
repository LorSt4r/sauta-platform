import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, type TestDbHandle } from '../db';
import {
  createFakeIdentityProvider,
  type IdentityProvider,
} from '../../src/utils/identityProvider';

describe('AuthKit, Console & WorkOS Webhook Routes (Wave 9C.0B - Extended Audit & Security)', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;
  let fakeIdProvider: ReturnType<typeof createFakeIdentityProvider>;
  let app: TestApp;

  const consoleHost = 'console.localhost:3001';

  beforeAll(async () => {
    db = await startTestDb();
    prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
    await prisma.$connect();

    fakeIdProvider = createFakeIdentityProvider();
    app = await createTestApp(prisma, {
      identityProvider: fakeIdProvider,
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.authAuditEvent.deleteMany();
    await prisma.processedWorkosEvent.deleteMany();
    await prisma.platformMutationReceipt.deleteMany();
    await prisma.identityProvisioningCommand.deleteMany();
    await prisma.venueInvitation.deleteMany();
    await prisma.venueOnboardingStep.deleteMany();
    await prisma.venueOnboarding.deleteMany();
    await prisma.venueMembership.deleteMany();
    await prisma.platformUser.deleteMany();
    await prisma.product.deleteMany();
    await prisma.venueDomain.deleteMany();
    await prisma.venue.deleteMany();
    fakeIdProvider.sessions.clear();
    fakeIdProvider.validCodes.clear();
    fakeIdProvider.validWebhookSignatures.clear();
    fakeIdProvider.logoutRequests.length = 0;
  });

  function transientCookie(
    state: string,
    verifier: string,
    issuedAt: number = Date.now()
  ): string {
    return app.fastify.signCookie(
      JSON.stringify({
        state,
        codeVerifier: verifier,
        returnTo: '/console',
        issuedAt,
      })
    );
  }

  it('1. GET /api/auth/login genera state, PKCE e cookie transitorio firmato', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/auth/login?returnTo=/console',
      headers: { host: consoleHost },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('http://authkit.workos.fake/auth');
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0].name).toBe('wos_transient');
  });

  it('2. GET /api/auth/login con X-Forwarded-Host spoofato e TRUST_PROXY=false viene respinto (404)', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/auth/login',
      headers: {
        host: 'venue.localhost:3001',
        'x-forwarded-host': 'console.localhost:3001',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('3. GET /api/auth/callback con cookie transitorio NON firmato o manomesso viene respinto (400)', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/auth/callback?code=code_123&state=state_123',
      headers: {
        host: consoleHost,
        cookie: 'wos_transient=raw_unsigned_cookie_value_without_fastify_signature',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Firma cookie transitorio non valida',
      reasonCode: 'auth_cookie_invalid_signature',
    });
  });

  it('4. GET /api/auth/callback per PLATFORM_ADMIN non esegue linking e risponde 401', async () => {
    const venue = await prisma.venue.create({
      data: {
        name: 'Venue Admin Check',
        workosOrganizationId: 'org_admin_check',
        isActive: true,
      },
    });

    // Utente invitato con ruolo PLATFORM_ADMIN (non deve MAI essere linkato da guest callback!)
    await prisma.platformUser.create({
      data: {
        emailNormalized: 'admin@sauta.app',
        status: 'INVITED',
        platformRole: 'PLATFORM_ADMIN',
        workosUserId: null,
      },
    });

    const code = 'code_admin_link';
    const verifier = 'fake_code_verifier_12345678901234567890';
    const state = 'state_admin_link';

    fakeIdProvider.validCodes.set(code, {
      verifier,
      user: {
        sessionId: 'sess_admin',
        userId: 'wos_admin_123',
        email: 'admin@sauta.app',
        emailVerified: true,
        organizationId: 'org_admin_check',
      },
    });

    const transientCookieValue = app.fastify.signCookie(
      JSON.stringify({ state, codeVerifier: verifier, returnTo: '/console', issuedAt: Date.now() })
    );

    const res = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=${code}&state=${state}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${transientCookieValue}`,
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: 'Utente non autorizzato o inattivo',
      reasonCode: 'unauthorized_user',
    });

    const adminUser = await prisma.platformUser.findFirst({ where: { emailNormalized: 'admin@sauta.app' } });
    expect(adminUser?.workosUserId).toBeNull();
  });

  it('5. GET /api/auth/callback con linking atomico esegue la mutazione e l\'audit nello stesso $transaction', async () => {
    const venue = await prisma.venue.create({
      data: {
        name: 'Venue Linking Test',
        workosOrganizationId: 'org_linking_1',
        isActive: true,
      },
    });

    const invited = await prisma.platformUser.create({
      data: {
        emailNormalized: 'invited@venue.com',
        status: 'INVITED',
        platformRole: 'NONE',
        workosUserId: null,
      },
    });

    await prisma.venueMembership.create({
      data: {
        userId: invited.id,
        venueId: venue.id,
        role: 'OWNER',
        status: 'PENDING',
      },
    });

    const code = 'valid_code_link_1';
    const verifier = 'fake_code_verifier_12345678901234567890';
    const state = 'valid_state_link_1';

    fakeIdProvider.validCodes.set(code, {
      verifier,
      user: {
        sessionId: 'sess_link_1',
        userId: 'wos_usr_link_1',
        email: 'invited@venue.com',
        emailVerified: true,
        organizationId: 'org_linking_1',
      },
    });

    const transientCookieValue = app.fastify.signCookie(
      JSON.stringify({ state, codeVerifier: verifier, returnTo: '/console', issuedAt: Date.now() })
    );

    const res = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=${code}&state=${state}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${transientCookieValue}`,
      },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/console');

    const updatedUser = await prisma.platformUser.findUnique({ where: { id: invited.id } });
    expect(updatedUser?.status).toBe('ACTIVE');
    expect(updatedUser?.workosUserId).toBe('wos_usr_link_1');

    const auditEvents = await prisma.authAuditEvent.findMany({ where: { actorUserId: invited.id } });
    expect(auditEvents.length).toBeGreaterThan(0);
    expect(auditEvents.some((e) => e.action === 'user:linked' && e.outcome === 'SUCCESS')).toBe(true);
  });

  it('5b. callback e switch pre-attivazione richiedono invito OWNER, membership, email e organization esatti', async () => {
    const creator = await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_creator_inactive',
        emailNormalized: 'creator-inactive@sauta.app',
        status: 'ACTIVE',
        platformRole: 'PLATFORM_ADMIN',
      },
    });
    const venue = await prisma.venue.create({
      data: {
        name: 'Venue Inactive Exact Owner',
        workosOrganizationId: 'org_inactive_exact',
        isActive: false,
        onboarding: { create: { status: 'DRAFT' } },
      },
    });
    const invited = await prisma.platformUser.create({
      data: {
        emailNormalized: 'inactive-owner@sauta.app',
        status: 'INVITED',
        platformRole: 'NONE',
      },
    });
    const membership = await prisma.venueMembership.create({
      data: {
        userId: invited.id,
        venueId: venue.id,
        role: 'OWNER',
        status: 'PENDING',
      },
    });
    const invitation = await prisma.venueInvitation.create({
      data: {
        venueId: venue.id,
        userId: invited.id,
        invitedEmailNormalized: invited.emailNormalized,
        role: 'OWNER',
        status: 'SENT',
        workosInvitationId: 'inv_inactive_exact',
        expiresAt: new Date(Date.now() + 60_000),
        sentAt: new Date(),
        createdByUserId: creator.id,
      },
    });

    const code = 'code_inactive_exact';
    const verifier = 'fake_code_verifier_12345678901234567890';
    const state = 'state_inactive_exact';
    fakeIdProvider.validCodes.set(code, {
      verifier,
      user: {
        sessionId: 'sess_inactive_exact',
        userId: 'wos_inactive_exact',
        email: invited.emailNormalized,
        emailVerified: true,
        organizationId: venue.workosOrganizationId!,
      },
    });

    const callback = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=${code}&state=${state}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${transientCookie(state, verifier)}`,
      },
    });
    expect(callback.statusCode).toBe(302);
    expect(
      (await prisma.platformUser.findUnique({ where: { id: invited.id } }))
        ?.workosUserId
    ).toBe('wos_inactive_exact');
    expect(
      (await prisma.venueMembership.findUnique({ where: { id: membership.id } }))
        ?.status
    ).toBe('ACTIVE');
    expect(
      (await prisma.venueInvitation.findUnique({ where: { id: invitation.id } }))
        ?.status
    ).toBe('ACCEPTED');

    const sessionCookie = callback.cookies.find(
      (cookie) => cookie.name === 'wos_session'
    );
    expect(sessionCookie).toBeDefined();
    const csrfToken = 'csrf_inactive_exact_123456789';
    const switched = await app.fastify.inject({
      method: 'POST',
      url: '/api/auth/switch-organization',
      headers: {
        host: consoleHost,
        origin: 'http://console.localhost:3001',
        'x-csrf-token': csrfToken,
        cookie:
          `wos_session=${sessionCookie!.value}; ` +
          `wos_csrf=${app.fastify.signCookie(csrfToken)}`,
      },
      payload: { organizationId: venue.workosOrganizationId },
    });
    expect(switched.statusCode).toBe(200);
  });

  it('5c. callback OWNER inattiva nega email diversa o invito scaduto senza mutazioni parziali', async () => {
    const creator = await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_creator_denied',
        emailNormalized: 'creator-denied@sauta.app',
        status: 'ACTIVE',
        platformRole: 'PLATFORM_ADMIN',
      },
    });
    const venue = await prisma.venue.create({
      data: {
        name: 'Venue Inactive Denied',
        workosOrganizationId: 'org_inactive_denied',
        isActive: false,
        onboarding: { create: { status: 'DRAFT' } },
      },
    });
    const invited = await prisma.platformUser.create({
      data: {
        emailNormalized: 'expected-owner@sauta.app',
        status: 'INVITED',
        platformRole: 'NONE',
      },
    });
    const membership = await prisma.venueMembership.create({
      data: {
        userId: invited.id,
        venueId: venue.id,
        role: 'OWNER',
        status: 'PENDING',
      },
    });
    const invitation = await prisma.venueInvitation.create({
      data: {
        venueId: venue.id,
        userId: invited.id,
        invitedEmailNormalized: invited.emailNormalized,
        role: 'OWNER',
        status: 'SENT',
        workosInvitationId: 'inv_inactive_expired',
        expiresAt: new Date(Date.now() - 1_000),
        sentAt: new Date(Date.now() - 10_000),
        createdByUserId: creator.id,
      },
    });
    const verifier = 'fake_code_verifier_12345678901234567890';
    const code = 'code_inactive_denied';
    const state = 'state_inactive_denied';
    fakeIdProvider.validCodes.set(code, {
      verifier,
      user: {
        sessionId: 'sess_inactive_denied',
        userId: 'wos_inactive_denied',
        email: invited.emailNormalized,
        emailVerified: true,
        organizationId: venue.workosOrganizationId!,
      },
    });

    const callback = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=${code}&state=${state}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${transientCookie(state, verifier)}`,
      },
    });
    expect(callback.statusCode).toBe(401);
    expect(
      (await prisma.platformUser.findUnique({ where: { id: invited.id } }))
        ?.workosUserId
    ).toBeNull();
    expect(
      (await prisma.venueMembership.findUnique({ where: { id: membership.id } }))
        ?.status
    ).toBe('PENDING');
    expect(
      (await prisma.venueInvitation.findUnique({ where: { id: invitation.id } }))
        ?.status
    ).toBe('SENT');

    await prisma.venueInvitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() + 60_000) },
    });
    const mismatchCode = 'code_inactive_email_mismatch';
    const mismatchState = 'state_inactive_email_mismatch';
    fakeIdProvider.validCodes.set(mismatchCode, {
      verifier,
      user: {
        sessionId: 'sess_inactive_email_mismatch',
        userId: 'wos_inactive_email_mismatch',
        email: 'different-owner@sauta.app',
        emailVerified: true,
        organizationId: venue.workosOrganizationId!,
      },
    });
    const mismatch = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=${mismatchCode}&state=${mismatchState}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${transientCookie(mismatchState, verifier)}`,
      },
    });
    expect(mismatch.statusCode).toBe(401);
    expect(
      (await prisma.platformUser.findUnique({ where: { id: invited.id } }))
        ?.workosUserId
    ).toBeNull();
    expect(
      await prisma.authAuditEvent.findFirst({
        where: {
          action: 'invitation:email_mismatch',
          reasonCode: 'invitation_verified_email_mismatch',
        },
      })
    ).not.toBeNull();
  });

  it('6. POST /api/auth/switch-organization con CSRF malformato risponde 403 senza RangeError', async () => {
    const user = await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_usr_csrf_test',
        emailNormalized: 'csrf@sauta.app',
        status: 'ACTIVE',
      },
    });

    const sealedSession = 'sealed_session_csrf_123';
    fakeIdProvider.sessions.set(sealedSession, {
      sessionId: 'sess_csrf',
      userId: 'wos_usr_csrf_test',
      email: 'csrf@sauta.app',
      emailVerified: true,
    });

    const signedCookie = app.fastify.signCookie(sealedSession);
    const csrfCookie = app.fastify.signCookie('real_csrf_token_24_chars_long');

    // Invia header CSRF con lunghezza differente
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/auth/switch-organization',
      headers: {
        host: consoleHost,
        origin: 'http://console.localhost:3001',
        'x-csrf-token': 'short_diff_len',
        cookie: `wos_session=${signedCookie}; wos_csrf=${csrfCookie}`,
      },
      payload: { organizationId: 'org_any' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: 'CSRF token non valido',
      reasonCode: 'csrf_invalid',
    });
  });

  it('7. Webhook organization_membership.updated gestisce data.status=inactive e previene race-conditions obsolete', async () => {
    const user = await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_usr_wh_status',
        emailNormalized: 'wh_status@sauta.app',
        status: 'ACTIVE',
      },
    });

    const venue = await prisma.venue.create({
      data: {
        name: 'Venue Webhook Status',
        workosOrganizationId: 'org_wh_status',
        isActive: true,
      },
    });

    const membership = await prisma.venueMembership.create({
      data: {
        userId: user.id,
        venueId: venue.id,
        workosMembershipId: 'wos_mem_123',
        role: 'STAFF',
        status: 'ACTIVE',
      },
    });

    const activeObjectTimestamp = new Date(Date.now() - 10_000);
    const inactiveObjectTimestamp = new Date(Date.now() - 5_000);

    // Un evento active viene elaborato localmente dopo il proprio updatedAt.
    fakeIdProvider.validWebhookSignatures.set('sig_active_1', {
      id: 'evt_wh_active_1',
      event: 'organization_membership.updated',
      createdAt: new Date().toISOString(),
      data: {
        id: 'wos_mem_123',
        userId: 'wos_usr_wh_status',
        organizationId: 'org_wh_status',
        status: 'active',
        updatedAt: activeObjectTimestamp.toISOString(),
      },
    });
    const resActive = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      headers: { 'workos-signature': 'sig_active_1' },
      payload: { dummy: 'payload' },
    });
    expect(resActive.statusCode).toBe(200);

    // L'inactive è più nuovo come oggetto provider, pur essendo antecedente
    // all'updatedAt locale prodotto dall'elaborazione precedente.
    fakeIdProvider.validWebhookSignatures.set('sig_inactive_1', {
      id: 'evt_wh_inactive_1',
      event: 'organization_membership.updated',
      createdAt: new Date().toISOString(),
      data: {
        id: 'wos_mem_123',
        userId: 'wos_usr_wh_status',
        organizationId: 'org_wh_status',
        status: 'inactive',
        updatedAt: inactiveObjectTimestamp.toISOString(),
      },
    });

    const resInactive = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      headers: { 'workos-signature': 'sig_inactive_1' },
      payload: { dummy: 'payload' },
    });

    expect(resInactive.statusCode).toBe(200);
    const updatedMembership = await prisma.venueMembership.findUnique({ where: { id: membership.id } });
    expect(updatedMembership?.status).toBe('INACTIVE');

    // 2. Invio evento obsoleto con timestamp passato -> viene ignorato per prevenire out-of-order race condition
    const oldTimestamp = new Date(Date.now() - 3600_000).toISOString();
    fakeIdProvider.validWebhookSignatures.set('sig_stale_1', {
      id: 'evt_wh_stale_1',
      event: 'organization_membership.updated',
      createdAt: oldTimestamp,
      data: {
        id: 'wos_mem_123',
        userId: 'wos_usr_wh_status',
        organizationId: 'org_wh_status',
        status: 'active',
        updatedAt: oldTimestamp,
      },
    });

    const resStale = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      headers: { 'workos-signature': 'sig_stale_1' },
      payload: { dummy: 'payload' },
    });

    expect(resStale.statusCode).toBe(200);
    const finalMembership = await prisma.venueMembership.findUnique({ where: { id: membership.id } });
    expect(finalMembership?.status).toBe('INACTIVE');
  });

  it('8. callback nega email non verificata, cookie scaduto e state riusato', async () => {
    const verifier = 'fake_code_verifier_12345678901234567890';

    fakeIdProvider.validCodes.set('code_unverified', {
      verifier,
      user: {
        sessionId: 'sess_unverified',
        userId: 'wos_unverified',
        email: 'unverified@example.com',
        emailVerified: false,
      },
    });
    const unverifiedState = 'state_unverified';
    const unverified = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=code_unverified&state=${unverifiedState}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${transientCookie(unverifiedState, verifier)}`,
      },
    });
    expect(unverified.statusCode).toBe(401);
    expect(unverified.json().reasonCode).toBe('email_unverified');

    const expiredState = 'state_expired';
    const expired = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=unused&state=${expiredState}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${transientCookie(
          expiredState,
          verifier,
          Date.now() - 600_001
        )}`,
      },
    });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().reasonCode).toBe('auth_cookie_expired');

    await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_preprovisioned_admin',
        emailNormalized: 'admin-preprovisioned@sauta.app',
        status: 'ACTIVE',
        platformRole: 'PLATFORM_ADMIN',
      },
    });
    fakeIdProvider.validCodes.set('code_one_time', {
      verifier,
      user: {
        sessionId: 'sess_one_time',
        userId: 'wos_preprovisioned_admin',
        email: 'admin-preprovisioned@sauta.app',
        emailVerified: true,
      },
    });
    const oneTimeState = 'state_one_time';
    const replayableCookie = transientCookie(oneTimeState, verifier);
    const first = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=code_one_time&state=${oneTimeState}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${replayableCookie}`,
      },
    });
    expect(first.statusCode).toBe(302);

    const replay = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=code_one_time&state=${oneTimeState}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${replayableCookie}`,
      },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().reasonCode).toBe('code_exchange_error');
  });

  it('9. callback riconcilia email verificata e nega collisione o organizzazione ignota', async () => {
    const venue = await prisma.venue.create({
      data: {
        name: 'Venue Reconciliation',
        workosOrganizationId: 'org_reconciliation',
        isActive: true,
      },
    });
    const user = await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_reconciliation',
        emailNormalized: 'old-email@example.com',
        status: 'ACTIVE',
      },
    });
    await prisma.venueMembership.create({
      data: {
        userId: user.id,
        venueId: venue.id,
        role: 'MANAGER',
        status: 'ACTIVE',
      },
    });

    const verifier = 'fake_code_verifier_12345678901234567890';
    fakeIdProvider.validCodes.set('code_reconcile', {
      verifier,
      user: {
        sessionId: 'sess_reconcile',
        userId: 'wos_reconciliation',
        email: '  New-Email@Example.COM ',
        emailVerified: true,
        organizationId: 'org_reconciliation',
      },
    });
    const reconcileState = 'state_reconcile';
    const reconcile = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=code_reconcile&state=${reconcileState}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${transientCookie(reconcileState, verifier)}`,
      },
    });
    expect(reconcile.statusCode).toBe(302);
    expect(
      (await prisma.platformUser.findUnique({ where: { id: user.id } }))?.emailNormalized
    ).toBe('new-email@example.com');

    const collision = await prisma.platformUser.create({
      data: {
        emailNormalized: 'collision@example.com',
        status: 'INVITED',
      },
    });
    fakeIdProvider.validCodes.set('code_collision', {
      verifier,
      user: {
        sessionId: 'sess_collision',
        userId: 'wos_reconciliation',
        email: collision.emailNormalized,
        emailVerified: true,
        organizationId: 'org_reconciliation',
      },
    });
    const collisionState = 'state_collision';
    const collisionRes = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=code_collision&state=${collisionState}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${transientCookie(collisionState, verifier)}`,
      },
    });
    expect(collisionRes.statusCode).toBe(401);
    expect(
      await prisma.authAuditEvent.findFirst({
        where: { reasonCode: 'verified_email_collision' },
      })
    ).not.toBeNull();

    fakeIdProvider.validCodes.set('code_unknown_org', {
      verifier,
      user: {
        sessionId: 'sess_unknown_org',
        userId: 'wos_reconciliation',
        email: 'new-email@example.com',
        emailVerified: true,
        organizationId: 'org_unknown',
      },
    });
    const unknownState = 'state_unknown_org';
    const unknownOrg = await app.fastify.inject({
      method: 'GET',
      url: `/api/auth/callback?code=code_unknown_org&state=${unknownState}`,
      headers: {
        host: consoleHost,
        cookie: `wos_transient=${transientCookie(unknownState, verifier)}`,
      },
    });
    expect(unknownOrg.statusCode).toBe(401);
  });

  it('10. Origin CSRF deve coincidere esattamente e logout usa il sessionId reale', async () => {
    await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_logout',
        emailNormalized: 'logout@sauta.app',
        status: 'ACTIVE',
        platformRole: 'PLATFORM_ADMIN',
      },
    });
    const sealedSession = 'sealed_session_logout';
    fakeIdProvider.sessions.set(sealedSession, {
      sessionId: 'sess_logout_real',
      userId: 'wos_logout',
      email: 'logout@sauta.app',
      emailVerified: true,
    });
    const sessionCookie = app.fastify.signCookie(sealedSession);
    const csrfToken = 'csrf_logout_token_1234567890';
    const csrfCookie = app.fastify.signCookie(csrfToken);

    const wrongOrigin = await app.fastify.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        host: consoleHost,
        origin: 'https://console.localhost:4444',
        'x-csrf-token': csrfToken,
        cookie: `wos_session=${sessionCookie}; wos_csrf=${csrfCookie}`,
      },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(fakeIdProvider.logoutRequests).toHaveLength(0);

    const logout = await app.fastify.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        host: consoleHost,
        origin: 'http://console.localhost:3001',
        'x-csrf-token': csrfToken,
        cookie: `wos_session=${sessionCookie}; wos_csrf=${csrfCookie}`,
      },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json().logoutUrl).toBe('http://console.localhost:3001?logged_out=true');
    expect(fakeIdProvider.logoutRequests).toEqual([
      {
        sessionId: 'sess_logout_real',
        postLogoutRedirectUri: 'http://console.localhost:3001',
      },
    ]);
    expect(
      logout.cookies.some(
        (cookie) => cookie.name === 'wos_session' && cookie.value === ''
      )
    ).toBe(true);
    expect(
      logout.cookies.some(
        (cookie) => cookie.name === 'wos_csrf' && cookie.value === ''
      )
    ).toBe(true);
    expect(
      logout.cookies.some(
        (cookie) => cookie.name === 'wos_transient' && cookie.value === ''
      )
    ).toBe(true);
  });

  it('11. switch cross-tenant è negato prima del refresh provider', async () => {
    const venue1 = await prisma.venue.create({
      data: {
        name: 'Venue Allowed',
        workosOrganizationId: 'org_allowed',
        isActive: true,
      },
    });
    await prisma.venue.create({
      data: {
        name: 'Venue Denied',
        workosOrganizationId: 'org_denied',
        isActive: true,
      },
    });
    const user = await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_switch_denied',
        emailNormalized: 'switch-denied@sauta.app',
        status: 'ACTIVE',
      },
    });
    await prisma.venueMembership.create({
      data: {
        userId: user.id,
        venueId: venue1.id,
        role: 'OWNER',
        status: 'ACTIVE',
      },
    });
    const sealedSession = 'sealed_session_switch_denied';
    fakeIdProvider.sessions.set(sealedSession, {
      sessionId: 'sess_switch_denied',
      userId: 'wos_switch_denied',
      email: 'switch-denied@sauta.app',
      emailVerified: true,
      organizationId: 'org_allowed',
    });
    const csrfToken = 'csrf_switch_denied_123456789';
    const response = await app.fastify.inject({
      method: 'POST',
      url: '/api/auth/switch-organization',
      headers: {
        host: consoleHost,
        origin: 'http://console.localhost:3001',
        'x-csrf-token': csrfToken,
        cookie:
          `wos_session=${app.fastify.signCookie(sealedSession)}; ` +
          `wos_csrf=${app.fastify.signCookie(csrfToken)}`,
      },
      payload: { organizationId: 'org_denied' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().reasonCode).toBe('membership_inactive');
    expect(fakeIdProvider.sessions.has(sealedSession)).toBe(true);
  });

  it('12. sessione scaduta fallisce chiusa e cancella il cookie', async () => {
    const invalidSealedSession = 'sealed_session_expired';
    const response = await app.fastify.inject({
      method: 'GET',
      url: '/api/console/me',
      headers: {
        host: consoleHost,
        cookie: `wos_session=${app.fastify.signCookie(invalidSealedSession)}`,
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().reasonCode).toBe('session_expired');
    expect(
      response.cookies.some(
        (cookie) => cookie.name === 'wos_session' && cookie.value === ''
      )
    ).toBe(true);
  });

  it('13. duplicate webhook concorrente applica una sola mutazione semantica', async () => {
    await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_concurrent',
        emailNormalized: 'before-concurrent@example.com',
        status: 'ACTIVE',
      },
    });
    fakeIdProvider.validWebhookSignatures.set('sig_concurrent', {
      id: 'evt_concurrent',
      event: 'user.updated',
      createdAt: new Date().toISOString(),
      data: {
        id: 'wos_concurrent',
        email: 'after-concurrent@example.com',
        emailVerified: true,
      },
    });

    const [first, second] = await Promise.all([
      app.fastify.inject({
        method: 'POST',
        url: '/api/webhooks/workos',
        headers: { 'workos-signature': 'sig_concurrent' },
        payload: { delivery: 1 },
      }),
      app.fastify.inject({
        method: 'POST',
        url: '/api/webhooks/workos',
        headers: { 'workos-signature': 'sig_concurrent' },
        payload: { delivery: 2 },
      }),
    ]);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(
      await prisma.processedWorkosEvent.count({ where: { eventId: 'evt_concurrent' } })
    ).toBe(1);
    expect(
      await prisma.authAuditEvent.count({
        where: {
          targetId: 'evt_concurrent',
          reasonCode: 'webhook_event_processed',
        },
      })
    ).toBe(1);
  });

  it('14. errore business rollbacka dedup e consente retry dello stesso evento', async () => {
    await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_rollback',
        emailNormalized: 'rollback-before@example.com',
        status: 'ACTIVE',
      },
    });
    const collision = await prisma.platformUser.create({
      data: {
        emailNormalized: 'rollback-collision@example.com',
        status: 'INVITED',
      },
    });
    fakeIdProvider.validWebhookSignatures.set('sig_rollback', {
      id: 'evt_rollback',
      event: 'user.updated',
      createdAt: new Date().toISOString(),
      data: {
        id: 'wos_rollback',
        email: collision.emailNormalized,
        emailVerified: true,
      },
    });

    const failed = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      headers: { 'workos-signature': 'sig_rollback' },
      payload: { delivery: 1 },
    });
    expect(failed.statusCode).toBe(500);
    expect(
      await prisma.processedWorkosEvent.findUnique({ where: { eventId: 'evt_rollback' } })
    ).toBeNull();

    await prisma.platformUser.delete({ where: { id: collision.id } });
    const retried = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      headers: { 'workos-signature': 'sig_rollback' },
      payload: { delivery: 2 },
    });
    expect(retried.statusCode).toBe(200);
    expect(
      await prisma.processedWorkosEvent.findUnique({ where: { eventId: 'evt_rollback' } })
    ).not.toBeNull();
  });

  it('15. evento non mappato è processed, audit ignored_unmapped e non concede accesso', async () => {
    fakeIdProvider.validWebhookSignatures.set('sig_unmapped', {
      id: 'evt_unmapped',
      event: 'organization.created',
      createdAt: new Date().toISOString(),
      data: { id: 'org_unmapped' },
    });
    const response = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      headers: { 'workos-signature': 'sig_unmapped' },
      payload: { dummy: true },
    });
    expect(response.statusCode).toBe(200);
    expect(await prisma.platformUser.count()).toBe(0);
    expect(await prisma.venueMembership.count()).toBe(0);
    expect(
      await prisma.authAuditEvent.findFirst({
        where: { targetId: 'evt_unmapped', reasonCode: 'ignored_unmapped' },
      })
    ).not.toBeNull();
  });

  it('16. ruolo provider non modifica il ruolo RBAC locale', async () => {
    const user = await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_role_stable',
        emailNormalized: 'role-stable@example.com',
        status: 'ACTIVE',
      },
    });
    const venue = await prisma.venue.create({
      data: {
        name: 'Venue Role Stable',
        workosOrganizationId: 'org_role_stable',
        isActive: true,
      },
    });
    const membership = await prisma.venueMembership.create({
      data: {
        userId: user.id,
        venueId: venue.id,
        workosMembershipId: 'om_role_stable',
        role: 'STAFF',
        status: 'ACTIVE',
      },
    });
    fakeIdProvider.validWebhookSignatures.set('sig_role_stable', {
      id: 'evt_role_stable',
      event: 'organization_membership.updated',
      createdAt: new Date().toISOString(),
      data: {
        id: 'om_role_stable',
        userId: 'wos_role_stable',
        organizationId: 'org_role_stable',
        status: 'active',
        role: { slug: 'admin' },
        updatedAt: new Date().toISOString(),
      },
    });
    const response = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      headers: { 'workos-signature': 'sig_role_stable' },
      payload: { dummy: true },
    });
    expect(response.statusCode).toBe(200);
    expect(
      (await prisma.venueMembership.findUnique({ where: { id: membership.id } }))?.role
    ).toBe('STAFF');
  });

  it('17. firma webhook assente non produce mutazioni business', async () => {
    const response = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      payload: {
        id: 'evt_unsigned',
        event: 'user.updated',
        data: { id: 'wos_unsigned', email: 'unsigned@example.com' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(await prisma.processedWorkosEvent.count()).toBe(0);
    expect(await prisma.platformUser.count()).toBe(0);
  });

  it('18. platform admin non bypassa venueGuard e i DTO restano minimali', async () => {
    const venue = await prisma.venue.create({
      data: {
        name: 'Venue DTO',
        workosOrganizationId: 'org_dto',
        isActive: true,
      },
    });
    await prisma.venue.create({
      data: {
        name: 'Venue Platform DTO',
        workosOrganizationId: 'org_platform_dto',
        isActive: false,
      },
    });
    await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_platform_dto',
        emailNormalized: 'platform-dto@sauta.app',
        status: 'ACTIVE',
        platformRole: 'PLATFORM_ADMIN',
      },
    });
    const sealedSession = 'sealed_session_platform_dto';
    fakeIdProvider.sessions.set(sealedSession, {
      sessionId: 'sess_platform_dto',
      userId: 'wos_platform_dto',
      email: 'platform-dto@sauta.app',
      emailVerified: true,
      organizationId: venue.workosOrganizationId!,
    });
    const cookie = `wos_session=${app.fastify.signCookie(sealedSession)}`;

    const venueResponse = await app.fastify.inject({
      method: 'GET',
      url: '/api/console/venue',
      headers: { host: consoleHost, cookie },
    });
    expect(venueResponse.statusCode).toBe(403);

    const meResponse = await app.fastify.inject({
      method: 'GET',
      url: '/api/console/me',
      headers: { host: consoleHost, cookie },
    });
    expect(meResponse.statusCode).toBe(200);
    expect(Object.keys(meResponse.json().user).sort()).toEqual([
      'email',
      'id',
      'platformRole',
    ]);
    expect(JSON.stringify(meResponse.json())).not.toContain('wos_platform_dto');

    const platformResponse = await app.fastify.inject({
      method: 'GET',
      url: '/api/platform/venues',
      headers: { host: consoleHost, cookie },
    });
    expect(platformResponse.statusCode).toBe(200);
    for (const venueDto of platformResponse.json().venues) {
      expect(Object.keys(venueDto).sort()).toEqual(['id', 'isActive', 'name']);
    }
    expect(JSON.stringify(platformResponse.json())).not.toContain(
      'org_platform_dto'
    );
  });

  it('19. probe di selettività: endpoint pubblici non interrogano alcun delegate identity', async () => {
    const venue = await prisma.venue.create({
      data: { name: 'Public Venue', isActive: true },
    });
    await prisma.venueDomain.create({
      data: {
        venueId: venue.id,
        hostname: 'public.localhost',
        type: 'PLATFORM',
        status: 'VERIFIED',
        isPrimary: true,
        verifiedAt: new Date(),
      },
    });
    const identityAccess = vi.fn();
    const identityDelegates = new Set<PropertyKey>([
      'platformUser',
      'venueMembership',
      'processedWorkosEvent',
      'authAuditEvent',
    ]);
    const probePrisma = new Proxy(prisma, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (identityDelegates.has(property) && typeof value === 'object') {
          return new Proxy(value, {
            get(delegate, method, delegateReceiver) {
              const delegateValue = Reflect.get(
                delegate,
                method,
                delegateReceiver
              );
              if (typeof delegateValue !== 'function') {
                return delegateValue;
              }
              return (...args: unknown[]) => {
                identityAccess(`${String(property)}.${String(method)}`);
                return Reflect.apply(delegateValue, delegate, args);
              };
            },
          });
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const probeApp = await createTestApp(probePrisma);

    try {
      const resPing = await probeApp.fastify.inject({
        method: 'GET',
        url: '/ping',
      });
      expect(resPing.statusCode).toBe(200);

      const resHealth = await probeApp.fastify.inject({
        method: 'GET',
        url: '/health',
      });
      expect(resHealth.statusCode).toBe(200);

      const venueResponse = await probeApp.fastify.inject({
        method: 'GET',
        url: '/api/venue/current',
        headers: { host: 'public.localhost:3001' },
      });
      expect(venueResponse.statusCode).toBe(200);

      const walletResponse = await probeApp.fastify.inject({
        method: 'POST',
        url: '/api/wallet/query',
        payload: {
          items: [
            {
              sessionId: 'session_public_probe',
              token: 'invalid-capability-format',
            },
          ],
        },
      });
      expect(walletResponse.statusCode).toBe(400);

      const stripeWebhookResponse = await probeApp.fastify.inject({
        method: 'POST',
        url: '/api/webhook/stripe',
        payload: { id: 'evt_public_probe' },
      });
      expect(stripeWebhookResponse.statusCode).toBe(400);

      expect(identityAccess).not.toHaveBeenCalled();
    } finally {
      await probeApp.close();
    }
  });

  it('20. gli HTML di console e PWA non sono serviti direttamente sull’host errato', async () => {
    const consoleOnVenue = await app.fastify.inject({
      method: 'GET',
      url: '/console.html',
      headers: { host: 'venue.localhost:3001' },
    });
    expect(consoleOnVenue.statusCode).toBe(404);

    const pwaOnConsole = await app.fastify.inject({
      method: 'GET',
      url: '/index.html',
      headers: { host: consoleHost },
    });
    expect(pwaOnConsole.statusCode).toBe(404);

    const callbackOnVenue = await app.fastify.inject({
      method: 'GET',
      url: '/api/auth/callback?code=synthetic&state=synthetic',
      headers: { host: 'venue.localhost:3001' },
    });
    expect(callbackOnVenue.statusCode).toBe(404);
    expect(callbackOnVenue.cookies).toHaveLength(0);
  });

  it('21. una sessione verificata resta offline e un refresh valido ruota il cookie', async () => {
    await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_refresh_rotation',
        emailNormalized: 'refresh-rotation@sauta.app',
        status: 'ACTIVE',
        platformRole: 'PLATFORM_ADMIN',
      },
    });

    const session = {
      sessionId: 'sess_refresh_rotation',
      userId: 'wos_refresh_rotation',
      email: 'refresh-rotation@sauta.app',
      emailVerified: true,
    };
    const authenticateSealedSession = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(null);
    const refreshSealedSession = vi.fn().mockResolvedValue({
      sealedSession: 'sealed_session_rotated',
      session,
    });
    const provider: IdentityProvider = {
      ...createFakeIdentityProvider(),
      authenticateSealedSession,
      refreshSealedSession,
    };
    const isolatedApp = await createTestApp(prisma, {
      identityProvider: provider,
    });

    try {
      const validCookie = isolatedApp.fastify.signCookie(
        'sealed_session_offline_valid'
      );
      const offlineResponse = await isolatedApp.fastify.inject({
        method: 'GET',
        url: '/api/console/me',
        headers: {
          host: consoleHost,
          cookie: `wos_session=${validCookie}`,
        },
      });
      expect(offlineResponse.statusCode).toBe(200);
      expect(refreshSealedSession).not.toHaveBeenCalled();

      const expiredCookie = isolatedApp.fastify.signCookie(
        'sealed_session_needs_refresh'
      );
      const refreshResponse = await isolatedApp.fastify.inject({
        method: 'GET',
        url: '/api/console/me',
        headers: {
          host: consoleHost,
          cookie: `wos_session=${expiredCookie}`,
        },
      });
      expect(refreshResponse.statusCode).toBe(200);
      expect(refreshSealedSession).toHaveBeenCalledOnce();
      expect(
        refreshResponse.cookies.some(
          (cookie) =>
            cookie.name === 'wos_session' &&
            cookie.value !== '' &&
            cookie.value !== expiredCookie
        )
      ).toBe(true);
    } finally {
      await isolatedApp.close();
    }
  });

  it('22. una sessione con email non verificata fallisce chiusa e cancella il cookie', async () => {
    await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_unverified_session',
        emailNormalized: 'unverified-session@sauta.app',
        status: 'ACTIVE',
        platformRole: 'PLATFORM_ADMIN',
      },
    });
    const sealedSession = 'sealed_session_unverified_email';
    fakeIdProvider.sessions.set(sealedSession, {
      sessionId: 'sess_unverified_email',
      userId: 'wos_unverified_session',
      email: 'unverified-session@sauta.app',
      emailVerified: false,
    });

    const response = await app.fastify.inject({
      method: 'GET',
      url: '/api/console/me',
      headers: {
        host: consoleHost,
        cookie: `wos_session=${app.fastify.signCookie(sealedSession)}`,
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().reasonCode).toBe('email_unverified');
    expect(
      response.cookies.some(
        (cookie) => cookie.name === 'wos_session' && cookie.value === ''
      )
    ).toBe(true);
  });

  it('23. user.deleted deprovisiona utente e revoca atomicamente tutte le membership', async () => {
    const user = await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_deleted_user',
        emailNormalized: 'deleted-user@sauta.app',
        status: 'ACTIVE',
      },
    });
    const venues = await Promise.all([
      prisma.venue.create({
        data: {
          name: 'Deleted User Venue A',
          workosOrganizationId: 'org_deleted_a',
        },
      }),
      prisma.venue.create({
        data: {
          name: 'Deleted User Venue B',
          workosOrganizationId: 'org_deleted_b',
        },
      }),
    ]);
    await prisma.venueMembership.createMany({
      data: venues.map((venue, index) => ({
        userId: user.id,
        venueId: venue.id,
        workosMembershipId: `om_deleted_${index}`,
        role: 'STAFF' as const,
        status: 'ACTIVE' as const,
      })),
    });
    fakeIdProvider.validWebhookSignatures.set('sig_user_deleted', {
      id: 'evt_user_deleted',
      event: 'user.deleted',
      createdAt: new Date().toISOString(),
      data: { id: 'wos_deleted_user' },
    });

    const response = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      headers: { 'workos-signature': 'sig_user_deleted' },
      payload: { synthetic: true },
    });
    expect(response.statusCode).toBe(200);
    expect(
      (await prisma.platformUser.findUnique({ where: { id: user.id } }))?.status
    ).toBe('DEPROVISIONED');
    expect(
      await prisma.venueMembership.count({
        where: { userId: user.id, status: 'INACTIVE' },
      })
    ).toBe(2);
    expect(
      await prisma.authAuditEvent.findFirst({
        where: {
          action: 'user:deprovisioned',
          reasonCode: 'user_deprovisioned',
        },
      })
    ).not.toBeNull();
    expect(
      await prisma.authAuditEvent.findFirst({
        where: {
          action: 'membership:inactivated',
          reasonCode: 'memberships_inactivated_for_deprovisioned_user',
        },
      })
    ).not.toBeNull();

    fakeIdProvider.validWebhookSignatures.set(
      'sig_deleted_user_reactivation',
      {
        id: 'evt_deleted_user_reactivation',
        event: 'organization_membership.updated',
        createdAt: new Date(Date.now() + 1_000).toISOString(),
        data: {
          id: 'om_deleted_0',
          userId: 'wos_deleted_user',
          organizationId: 'org_deleted_a',
          status: 'active',
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        },
      }
    );
    const reactivationAttempt = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      headers: { 'workos-signature': 'sig_deleted_user_reactivation' },
      payload: { synthetic: true },
    });
    expect(reactivationAttempt.statusCode).toBe(200);
    expect(
      (
        await prisma.venueMembership.findUnique({
          where: { workosMembershipId: 'om_deleted_0' },
        })
      )?.status
    ).toBe('INACTIVE');
  });

  it('24. membership.deleted revoca la membership e produce audit di dominio', async () => {
    const user = await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_membership_deleted',
        emailNormalized: 'membership-deleted@sauta.app',
        status: 'ACTIVE',
      },
    });
    const venue = await prisma.venue.create({
      data: {
        name: 'Membership Deleted Venue',
        workosOrganizationId: 'org_membership_deleted',
      },
    });
    const membership = await prisma.venueMembership.create({
      data: {
        userId: user.id,
        venueId: venue.id,
        workosMembershipId: 'om_membership_deleted',
        role: 'MANAGER',
        status: 'ACTIVE',
      },
    });
    const timestamp = new Date().toISOString();
    fakeIdProvider.validWebhookSignatures.set('sig_membership_deleted', {
      id: 'evt_membership_deleted',
      event: 'organization_membership.deleted',
      createdAt: timestamp,
      data: {
        id: 'om_membership_deleted',
        userId: 'wos_membership_deleted',
        organizationId: 'org_membership_deleted',
        status: 'inactive',
        updatedAt: timestamp,
      },
    });

    const response = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      headers: { 'workos-signature': 'sig_membership_deleted' },
      payload: { synthetic: true },
    });
    expect(response.statusCode).toBe(200);
    expect(
      (
        await prisma.venueMembership.findUnique({
          where: { id: membership.id },
        })
      )?.status
    ).toBe('INACTIVE');
    expect(
      await prisma.authAuditEvent.findFirst({
        where: {
          action: 'membership:inactivated',
          targetId: membership.id,
        },
      })
    ).not.toBeNull();
  });

  it('25. user.updated non riconcilia un indirizzo non verificato', async () => {
    const user = await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_email_unverified_update',
        emailNormalized: 'verified-current@sauta.app',
        status: 'ACTIVE',
      },
    });
    fakeIdProvider.validWebhookSignatures.set('sig_email_unverified_update', {
      id: 'evt_email_unverified_update',
      event: 'user.updated',
      createdAt: new Date().toISOString(),
      data: {
        id: 'wos_email_unverified_update',
        email: 'unverified-new@sauta.app',
        emailVerified: false,
      },
    });

    const response = await app.fastify.inject({
      method: 'POST',
      url: '/api/webhooks/workos',
      headers: { 'workos-signature': 'sig_email_unverified_update' },
      payload: { synthetic: true },
    });
    expect(response.statusCode).toBe(200);
    expect(
      (await prisma.platformUser.findUnique({ where: { id: user.id } }))
        ?.emailNormalized
    ).toBe('verified-current@sauta.app');
    expect(
      await prisma.authAuditEvent.findFirst({
        where: {
          targetId: 'evt_email_unverified_update',
          reasonCode: 'ignored_unmapped',
        },
      })
    ).not.toBeNull();
  });

  it('26. user, membership e venue inattivi falliscono sempre chiusi', async () => {
    const venue = await prisma.venue.create({
      data: {
        name: 'Fail Closed Venue',
        workosOrganizationId: 'org_fail_closed',
        isActive: false,
      },
    });
    const user = await prisma.platformUser.create({
      data: {
        workosUserId: 'wos_fail_closed',
        emailNormalized: 'fail-closed@sauta.app',
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
    const sealedSession = 'sealed_session_fail_closed';
    fakeIdProvider.sessions.set(sealedSession, {
      sessionId: 'sess_fail_closed',
      userId: 'wos_fail_closed',
      email: 'fail-closed@sauta.app',
      emailVerified: true,
      organizationId: 'org_fail_closed',
    });
    const cookie = `wos_session=${app.fastify.signCookie(sealedSession)}`;

    const inactiveVenue = await app.fastify.inject({
      method: 'GET',
      url: '/api/console/venue',
      headers: { host: consoleHost, cookie },
    });
    expect(inactiveVenue.statusCode).toBe(404);

    await prisma.venue.update({
      where: { id: venue.id },
      data: { isActive: true },
    });
    await prisma.venueMembership.update({
      where: { id: membership.id },
      data: { status: 'INACTIVE' },
    });
    const inactiveMembership = await app.fastify.inject({
      method: 'GET',
      url: '/api/console/venue',
      headers: { host: consoleHost, cookie },
    });
    expect(inactiveMembership.statusCode).toBe(403);

    await prisma.platformUser.update({
      where: { id: user.id },
      data: { status: 'SUSPENDED' },
    });
    const suspendedUser = await app.fastify.inject({
      method: 'GET',
      url: '/api/console/me',
      headers: { host: consoleHost, cookie },
    });
    expect(suspendedUser.statusCode).toBe(401);
    expect(
      suspendedUser.cookies.some(
        (responseCookie) =>
          responseCookie.name === 'wos_session' &&
          responseCookie.value === ''
      )
    ).toBe(true);
  });

  it('27. le guardie HTTP applicano la matrice locale OWNER, MANAGER e STAFF', async () => {
    const venue = await prisma.venue.create({
      data: {
        name: 'Venue HTTP Role Matrix',
        workosOrganizationId: 'org_http_role_matrix',
        isActive: true,
      },
    });
    const roleCases = [
      { role: 'OWNER' as const, statusCode: 200 },
      { role: 'MANAGER' as const, statusCode: 200 },
      { role: 'STAFF' as const, statusCode: 403 },
    ];

    for (const roleCase of roleCases) {
      const suffix = roleCase.role.toLowerCase();
      const user = await prisma.platformUser.create({
        data: {
          workosUserId: `wos_http_${suffix}`,
          emailNormalized: `${suffix}-http@sauta.app`,
          status: 'ACTIVE',
        },
      });
      await prisma.venueMembership.create({
        data: {
          userId: user.id,
          venueId: venue.id,
          role: roleCase.role,
          status: 'ACTIVE',
        },
      });
      const sealedSession = `sealed_session_http_${suffix}`;
      fakeIdProvider.sessions.set(sealedSession, {
        sessionId: `sess_http_${suffix}`,
        userId: `wos_http_${suffix}`,
        email: `${suffix}-http@sauta.app`,
        emailVerified: true,
        organizationId: 'org_http_role_matrix',
      });

      const response = await app.fastify.inject({
        method: 'GET',
        url: '/api/console/venue',
        headers: {
          host: consoleHost,
          cookie: `wos_session=${app.fastify.signCookie(sealedSession)}`,
        },
      });
      expect(response.statusCode).toBe(roleCase.statusCode);
      if (response.statusCode === 200) {
        expect(response.json().venue.role).toBe(roleCase.role);
        expect(response.json().venue.permissions).toContain('venue:read');
      }
    }
  });
});
