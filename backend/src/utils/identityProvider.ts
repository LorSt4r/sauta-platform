import { WorkOS, PKCE, CookieSession } from '@workos-inc/node';
import crypto from 'node:crypto';
import type { AppConfig } from './config';

export interface WorkosNormalizedSession {
  sessionId: string;
  userId: string;
  email: string;
  emailVerified: boolean;
  organizationId?: string | undefined;
}

export interface WorkosWebhookEvent {
  id: string;
  event: string;
  createdAt?: string | undefined;
  data: {
    id?: string;
    email?: string;
    emailVerified?: boolean;
    organizationId?: string;
    status?: string;
    updatedAt?: string;
    updated_at?: string;
    userId?: string;
    [key: string]: unknown;
  };
}

export interface WorkosOrganizationDto {
  id: string;
  name: string;
  externalId: string | null;
}

export interface WorkosInvitationDto {
  id: string;
  organizationId: string;
  email: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string | null;
}

export interface IdentityProvider {
  getAuthorizationUrlWithPKCE(opts: {
    state: string;
    redirectUri: string;
    returnTo?: string;
    screenHint?: 'sign-in' | 'sign-up' | undefined;
  }): Promise<{ url: string; codeVerifier: string }>;

  exchangeCodeAndSealSession(opts: {
    code: string;
    codeVerifier: string;
  }): Promise<{ sealedSession: string; session: WorkosNormalizedSession }>;

  authenticateSealedSession(sealedSession: string): Promise<WorkosNormalizedSession | null>;

  refreshSealedSession(
    sealedSession: string,
    organizationId?: string
  ): Promise<{ sealedSession: string; session: WorkosNormalizedSession } | null>;

  getLogoutUrl(opts: { sessionId: string; postLogoutRedirectUri: string }): string;

  verifyWebhookSignature(opts: {
    payload: unknown;
    sigHeader: string;
  }): Promise<WorkosWebhookEvent>;

  // --- Wave 9C.0C Organization & Invitation Provisioning Methods ---
  createOrganization(opts: {
    name: string;
    externalId: string;
    idempotencyKey: string;
  }): Promise<WorkosOrganizationDto>;
  findOrganizationByExternalId(externalId: string): Promise<WorkosOrganizationDto | null>;
  listInvitationsByOrganizationAndEmail(opts: {
    organizationId: string;
    email: string;
  }): Promise<WorkosInvitationDto[]>;
  getInvitation(invitationId: string): Promise<WorkosInvitationDto | null>;
  sendInvitation(opts: {
    organizationId: string;
    email: string;
  }): Promise<WorkosInvitationDto>;
  revokeInvitation(invitationId: string): Promise<WorkosInvitationDto>;
  resendInvitation(invitationId: string): Promise<WorkosInvitationDto>;
}

export function createWorkosIdentityProvider(config: AppConfig): IdentityProvider {
  const workos = new WorkOS(config.WORKOS_API_KEY, {
    clientId: config.WORKOS_CLIENT_ID,
  });
  const pkce = new PKCE();

  const mapInvitation = (inv: Record<string, unknown>): WorkosInvitationDto => {
    const rawStatus = String(inv.state || inv.status || 'pending').toLowerCase();
    let status: 'pending' | 'accepted' | 'revoked' | 'expired' = 'pending';
    if (rawStatus === 'accepted' || rawStatus === 'revoked' || rawStatus === 'expired') {
      status = rawStatus;
    }
    return {
      id: String(inv.id),
      organizationId: String(inv.organizationId || inv.organization_id || ''),
      email: String(inv.email || '').trim().toLowerCase(),
      status,
      expiresAt: inv.expiresAt || inv.expires_at
        ? String(inv.expiresAt || inv.expires_at)
        : null,
    };
  };

  const isNotFoundError = (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return false;
    const candidate = err as { status?: number; statusCode?: number; response?: { status?: number } };
    return candidate.status === 404 ||
      candidate.statusCode === 404 ||
      candidate.response?.status === 404;
  };

  return {
    async getAuthorizationUrlWithPKCE(opts) {
      const { codeVerifier, codeChallenge } = await pkce.generate();

      const authOpts = {
        provider: 'authkit',
        redirectUri: opts.redirectUri,
        state: opts.state,
        codeChallenge,
        codeChallengeMethod: 'S256' as const,
        ...(opts.screenHint ? { screenHint: opts.screenHint } : {}),
      };

      const url = workos.userManagement.getAuthorizationUrl(authOpts);

      return { url, codeVerifier };
    },

    async exchangeCodeAndSealSession(opts) {
      const resp = await workos.userManagement.authenticateWithCode({
        code: opts.code,
        codeVerifier: opts.codeVerifier,
        session: {
          sealSession: true,
          cookiePassword: config.WORKOS_COOKIE_PASSWORD,
        },
      });

      if (!resp.sealedSession) {
        throw new Error('identity_provider_missing_sealed_session');
      }

      const cookieSession = new CookieSession(
        workos.userManagement,
        resp.sealedSession,
        config.WORKOS_COOKIE_PASSWORD
      );
      const authResult = await cookieSession.authenticate();
      if (!authResult.authenticated || !authResult.user || !authResult.sessionId) {
        throw new Error('identity_provider_invalid_sealed_session');
      }

      const session: WorkosNormalizedSession = {
        sessionId: authResult.sessionId,
        userId: authResult.user.id,
        email: authResult.user.email.trim().toLowerCase(),
        emailVerified: authResult.user.emailVerified,
        organizationId: authResult.organizationId || undefined,
      };

      return { sealedSession: resp.sealedSession, session };
    },

    async authenticateSealedSession(sealedSession) {
      try {
        const cs = new CookieSession(
          workos.userManagement,
          sealedSession,
          config.WORKOS_COOKIE_PASSWORD
        );
        const authResult = await cs.authenticate();

        if (!authResult || !authResult.authenticated) {
          return null;
        }

        const user = authResult.user;
        if (!user) return null;

        if (!authResult.sessionId) return null;

        const session: WorkosNormalizedSession = {
          sessionId: authResult.sessionId,
          userId: user.id,
          email: user.email.trim().toLowerCase(),
          emailVerified: user.emailVerified,
          organizationId: authResult.organizationId || undefined,
        };

        return session;
      } catch (err) {
        return null;
      }
    },

    async refreshSealedSession(sealedSession, organizationId) {
      try {
        const cs = new CookieSession(
          workos.userManagement,
          sealedSession,
          config.WORKOS_COOKIE_PASSWORD
        );
        const refreshOpts = organizationId ? { organizationId } : {};
        const refreshResult = await cs.refresh(refreshOpts);

        if (
          !refreshResult ||
          !refreshResult.authenticated ||
          !refreshResult.sealedSession ||
          !refreshResult.sessionId ||
          !refreshResult.user
        ) {
          return null;
        }

        const session: WorkosNormalizedSession = {
          sessionId: refreshResult.sessionId,
          userId: refreshResult.user.id,
          email: refreshResult.user.email.trim().toLowerCase(),
          emailVerified: refreshResult.user.emailVerified,
          organizationId: refreshResult.organizationId || undefined,
        };

        return { sealedSession: refreshResult.sealedSession, session };
      } catch (err) {
        return null;
      }
    },

    getLogoutUrl(opts) {
      return workos.userManagement.getLogoutUrl({
        sessionId: opts.sessionId,
        returnTo: opts.postLogoutRedirectUri,
      });
    },

    async verifyWebhookSignature(opts) {
      const payloadString =
        typeof opts.payload === 'string'
          ? opts.payload
          : Buffer.isBuffer(opts.payload)
            ? opts.payload
            : JSON.stringify(opts.payload);
      if (
        typeof payloadString !== 'string' &&
        !Buffer.isBuffer(payloadString)
      ) {
        throw new Error('identity_provider_invalid_webhook_payload');
      }

      const event = await workos.webhooks.constructEvent({
        payload: payloadString,
        sigHeader: opts.sigHeader,
        secret: config.WORKOS_WEBHOOK_SECRET,
      });

      return {
        id: event.id,
        event: event.event,
        createdAt: event.createdAt,
        data: event.data as unknown as WorkosWebhookEvent['data'],
      };
    },

    async createOrganization(opts) {
      const org = await workos.organizations.createOrganization({
        name: opts.name,
        externalId: opts.externalId,
      }, {
        idempotencyKey: opts.idempotencyKey,
      });
      return {
        id: org.id,
        name: org.name,
        externalId: org.externalId || null,
      };
    },

    async findOrganizationByExternalId(externalId) {
      try {
        const org = await workos.organizations.getOrganizationByExternalId(externalId);
        return {
          id: org.id,
          name: org.name,
          externalId: org.externalId || null,
        };
      } catch (err) {
        if (!isNotFoundError(err)) {
          throw err;
        }
      }

      let after: string | undefined = undefined;
      while (true) {
        const orgsList = await workos.organizations.listOrganizations(after ? { after } : undefined);
        const match = orgsList.data.find((organization) => organization.externalId === externalId);
        if (match) {
          return {
            id: match.id,
            name: match.name,
            externalId: match.externalId || null,
          };
        }
        if (!orgsList.listMetadata?.after) {
          break;
        }
        after = orgsList.listMetadata.after;
      }
      return null;
    },

    async listInvitationsByOrganizationAndEmail(opts) {
      const invitations: WorkosInvitationDto[] = [];
      let after: string | undefined;
      do {
        const list = await workos.userManagement.listInvitations({
          organizationId: opts.organizationId,
          email: opts.email,
          ...(after ? { after } : {}),
        });
        invitations.push(
          ...list.data.map((invitation) =>
            mapInvitation(invitation as unknown as Record<string, unknown>)
          )
        );
        after = list.listMetadata.after ?? undefined;
      } while (after);
      return invitations;
    },

    async getInvitation(invitationId) {
      try {
        const inv = await workos.userManagement.getInvitation(invitationId);
        return mapInvitation(inv as unknown as Record<string, unknown>);
      } catch (err) {
        if (isNotFoundError(err)) return null;
        throw err;
      }
    },

    async sendInvitation(opts) {
      const inv = await workos.userManagement.sendInvitation({
        organizationId: opts.organizationId,
        email: opts.email,
      });
      return mapInvitation(inv as unknown as Record<string, unknown>);
    },

    async revokeInvitation(invitationId) {
      const inv = await workos.userManagement.revokeInvitation(invitationId);
      return mapInvitation(inv as unknown as Record<string, unknown>);
    },

    async resendInvitation(invitationId) {
      try {
        const inv = await workos.userManagement.resendInvitation(invitationId);
        return mapInvitation(inv as unknown as Record<string, unknown>);
      } catch {
        throw new Error('workos_resend_ambiguous_failure');
      }
    },
  };
}

/**
 * Fake IdentityProvider per test unitari e d'integrazione offline senza chiamate di rete.
 */
export function createFakeIdentityProvider(): IdentityProvider & {
  sessions: Map<string, WorkosNormalizedSession>;
  validCodes: Map<string, { user: WorkosNormalizedSession; verifier: string }>;
  validWebhookSignatures: Map<string, WorkosWebhookEvent>;
  logoutRequests: Array<{ sessionId: string; postLogoutRedirectUri: string }>;
  organizations: Map<string, WorkosOrganizationDto>;
  invitations: Map<string, WorkosInvitationDto>;
  organizationCreateRequests: Array<{ name: string; externalId: string; idempotencyKey: string }>;
  invitationSendRequests: Array<{ organizationId: string; email: string }>;
  invitationResendRequests: string[];
  invitationRevokeRequests: string[];
  simulateTimeoutOrAmbiguousError?: boolean;
  simulateSendTimeoutOrAmbiguousError?: boolean;
  simulateResendAmbiguousFailure?: boolean;
} {
  const sessions = new Map<string, WorkosNormalizedSession>();
  const validCodes = new Map<string, { user: WorkosNormalizedSession; verifier: string }>();
  const validWebhookSignatures = new Map<string, WorkosWebhookEvent>();
  const logoutRequests: Array<{ sessionId: string; postLogoutRedirectUri: string }> = [];
  const organizations = new Map<string, WorkosOrganizationDto>();
  const invitations = new Map<string, WorkosInvitationDto>();
  const organizationCreateRequests: Array<{ name: string; externalId: string; idempotencyKey: string }> = [];
  const invitationSendRequests: Array<{ organizationId: string; email: string }> = [];
  const invitationResendRequests: string[] = [];
  const invitationRevokeRequests: string[] = [];
  let sessionCounter = 0;
  let organizationCounter = 0;
  let invitationCounter = 0;
  const instanceNamespace = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const deterministicExpiry = '2099-01-01T00:00:00.000Z';

  const fakeProvider = {
    sessions,
    validCodes,
    validWebhookSignatures,
    logoutRequests,
    organizations,
    invitations,
    organizationCreateRequests,
    invitationSendRequests,
    invitationResendRequests,
    invitationRevokeRequests,
    simulateTimeoutOrAmbiguousError: false,
    simulateSendTimeoutOrAmbiguousError: false,
    simulateResendAmbiguousFailure: false,

    async getAuthorizationUrlWithPKCE(opts: { state: string; redirectUri: string }) {
      const codeVerifier = 'fake_code_verifier_12345678901234567890';
      const url = `http://authkit.workos.fake/auth?state=${encodeURIComponent(opts.state)}&redirect_uri=${encodeURIComponent(opts.redirectUri)}`;
      return { url, codeVerifier };
    },

    async exchangeCodeAndSealSession(opts: { code: string; codeVerifier: string }) {
      const entry = validCodes.get(opts.code);
      if (!entry || entry.verifier !== opts.codeVerifier) {
        throw new Error('Code verification failed');
      }
      validCodes.delete(opts.code);

      sessionCounter += 1;
      const sealedSession = `sealed_session_${entry.user.sessionId}_${sessionCounter}`;
      sessions.set(sealedSession, entry.user);

      return { sealedSession, session: entry.user };
    },

    async authenticateSealedSession(sealedSession: string) {
      if (!sealedSession || !sealedSession.startsWith('sealed_session_')) {
        return null;
      }
      return sessions.get(sealedSession) || null;
    },

    async refreshSealedSession(sealedSession: string, organizationId?: string) {
      const current = sessions.get(sealedSession);
      if (!current) return null;

      const updatedSession: WorkosNormalizedSession = {
        ...current,
        organizationId: organizationId || current.organizationId,
      };

      sessionCounter += 1;
      const newSealedSession = `sealed_session_${updatedSession.sessionId}_${sessionCounter}`;
      sessions.set(newSealedSession, updatedSession);

      return { sealedSession: newSealedSession, session: updatedSession };
    },

    getLogoutUrl(opts: { sessionId: string; postLogoutRedirectUri: string }) {
      logoutRequests.push(opts);
      return `${opts.postLogoutRedirectUri}?logged_out=true`;
    },

    async verifyWebhookSignature(opts: { payload: unknown; sigHeader: string }) {
      const sig = opts.sigHeader;
      if (!sig || sig.startsWith('invalid')) {
        throw new Error('Invalid WorkOS webhook signature');
      }

      const found = validWebhookSignatures.get(sig);
      if (found) return found;

      const parsedPayload: unknown =
        typeof opts.payload === 'string'
          ? JSON.parse(opts.payload)
          : opts.payload;
      if (
        !parsedPayload ||
        typeof parsedPayload !== 'object' ||
        Array.isArray(parsedPayload)
      ) {
        throw new Error('Invalid synthetic WorkOS webhook payload');
      }
      const payloadObj = parsedPayload as Partial<WorkosWebhookEvent>;
      return {
        id: payloadObj.id || 'evt_fake_123',
        event: payloadObj.event || 'user.updated',
        createdAt: payloadObj.createdAt || '2026-01-01T00:00:00.000Z',
        data: payloadObj.data || {},
      };
    },

    async createOrganization(opts: { name: string; externalId: string; idempotencyKey: string }) {
      organizationCreateRequests.push({ ...opts });
      const existing = Array.from(organizations.values()).find((o) => o.externalId === opts.externalId);
      if (existing) {
        return existing;
      }
      organizationCounter += 1;
      const orgId = `org_fake_${instanceNamespace}_${organizationCounter}`;
      const dto: WorkosOrganizationDto = { id: orgId, name: opts.name, externalId: opts.externalId };
      organizations.set(orgId, dto);

      if (fakeProvider.simulateTimeoutOrAmbiguousError) {
        throw new Error('workos_provider_timeout_ambiguous');
      }
      return dto;
    },

    async findOrganizationByExternalId(externalId: string) {
      const match = Array.from(organizations.values()).find((o) => o.externalId === externalId);
      return match || null;
    },

    async listInvitationsByOrganizationAndEmail(opts: { organizationId: string; email: string }) {
      const targetEmail = opts.email.trim().toLowerCase();
      return Array.from(invitations.values()).filter(
        (i) => i.organizationId === opts.organizationId && i.email.toLowerCase() === targetEmail
      );
    },

    async getInvitation(invitationId: string) {
      return invitations.get(invitationId) || null;
    },

    async sendInvitation(opts: { organizationId: string; email: string }) {
      const normalized = { organizationId: opts.organizationId, email: opts.email.trim().toLowerCase() };
      invitationSendRequests.push(normalized);
      invitationCounter += 1;
      const invId = `inv_fake_${instanceNamespace}_${invitationCounter}`;
      const dto: WorkosInvitationDto = {
        id: invId,
        ...normalized,
        status: 'pending',
        expiresAt: deterministicExpiry,
      };
      invitations.set(invId, dto);
      if (fakeProvider.simulateSendTimeoutOrAmbiguousError) {
        throw new Error('workos_send_invitation_timeout_ambiguous');
      }
      return dto;
    },

    async revokeInvitation(invitationId: string) {
      invitationRevokeRequests.push(invitationId);
      const inv = invitations.get(invitationId);
      if (!inv) {
        throw new Error('invitation_not_found');
      }
      const updated: WorkosInvitationDto = { ...inv, status: 'revoked' };
      invitations.set(invitationId, updated);
      return updated;
    },

    async resendInvitation(invitationId: string) {
      invitationResendRequests.push(invitationId);
      if (fakeProvider.simulateResendAmbiguousFailure) {
        throw new Error('workos_resend_ambiguous_failure');
      }
      const inv = invitations.get(invitationId);
      if (!inv) {
        throw new Error('invitation_not_found');
      }
      const updated: WorkosInvitationDto = {
        id: invitationId,
        organizationId: inv.organizationId,
        email: inv.email,
        status: 'pending',
        expiresAt: deterministicExpiry,
      };
      invitations.set(invitationId, updated);
      return updated;
    },
  };

  return fakeProvider;
}
