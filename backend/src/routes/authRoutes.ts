import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../utils/config';
import type { IdentityProvider } from '../utils/identityProvider';
import {
  createSessionGuard,
  createPlatformGuard,
  createVenueGuard,
  verifyCsrfToken,
  getRequestHostname,
  setAuthCookie,
  clearAuthCookie,
} from './authGuards';
import { getVenuePermissions } from '../utils/rbac';
import {
  logAuthAuditEvent,
  type AuthAuditReasonCode,
} from '../utils/auditLogger';
import { updateOnboardingStateTx } from '../services/identityProvisioningService';
import crypto from 'node:crypto';

export function normalizeWorkosEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeConsoleReturnTo(returnTo: unknown): string {
  if (
    typeof returnTo === 'string' &&
    /^\/console(?:\?[^#]*)?$/.test(returnTo)
  ) {
    return returnTo;
  }
  return '/console';
}

export function isTransientIssuedAtValid(
  issuedAt: unknown,
  now: number = Date.now()
): issuedAt is number {
  return (
    typeof issuedAt === 'number' &&
    Number.isSafeInteger(issuedAt) &&
    issuedAt <= now &&
    now - issuedAt <= 600_000
  );
}

function getAuditOriginInfo(req: FastifyRequest): {
  ip?: string;
  userAgent?: string;
} {
  const userAgent = req.headers['user-agent'];
  return {
    ip: req.ip,
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
  };
}

export async function registerAuthRoutes(
  fastify: FastifyInstance,
  opts: {
    prisma: PrismaClient;
    config: AppConfig;
    identityProvider: IdentityProvider;
  }
) {
  const { prisma, config, identityProvider } = opts;
  const sessionGuard = createSessionGuard(prisma, config, identityProvider);
  const platformVenuesGuard = createPlatformGuard('platform:venues:read', prisma, config);
  const venueReadGuard = createVenueGuard('venue:read', prisma, config);

  const consoleHostname = new URL(config.CONSOLE_ORIGIN).hostname;

  // Helper per la verifica dell'host console (rispetta TRUST_PROXY)
  const requireConsoleHost = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const reqHostname = getRequestHostname(req, config);
    if (reqHostname !== consoleHostname) {
      reply.status(404).send({ error: 'Not Found' });
      return false;
    }
    return true;
  };

  const authRateLimitOptions = {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
      },
    },
  };

  // GET /api/auth/login
  fastify.get('/api/auth/login', {
    ...authRateLimitOptions,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          returnTo: { type: 'string', maxLength: 2048 },
        },
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;

    const { returnTo: rawReturnTo } = req.query as { returnTo?: string };
    const returnTo = normalizeConsoleReturnTo(rawReturnTo);

    const state = crypto.randomBytes(32).toString('hex');
    const { url, codeVerifier } = await identityProvider.getAuthorizationUrlWithPKCE({
      state,
      redirectUri: config.WORKOS_REDIRECT_URI,
      returnTo,
    });

    const transientPayload = JSON.stringify({
      state,
      codeVerifier,
      returnTo,
      issuedAt: Date.now(),
    });

    setAuthCookie(reply, config, 'wos_transient', transientPayload, { maxAge: 600 });

    await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
      requestId: req.id || `req_${Date.now()}`,
      action: 'auth:login_initiated',
      outcome: 'SUCCESS',
      reasonCode: 'login_started',
      channel: 'USER',
      originInfo: getAuditOriginInfo(req),
    });

    return reply.redirect(url, 302);
  });

  // GET /api/auth/callback
  fastify.get('/api/auth/callback', {
    ...authRateLimitOptions,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 4096 },
          state: { type: 'string', minLength: 1, maxLength: 512 },
          error: { type: 'string', minLength: 1, maxLength: 256 },
          error_description: { type: 'string', maxLength: 2048 },
        },
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;

    const transientCookieName = (config.IS_PRODUCTION ? '__Host-' : '') + 'wos_transient';
    const rawTransientCookie = req.cookies[transientCookieName];

    // Consuma SEMPRE il cookie transitorio
    clearAuthCookie(reply, config, 'wos_transient');

    const query = req.query as { code?: string; state?: string; error?: string };

    if (query.error || !query.code || !query.state) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'auth:callback',
        outcome: 'DENIED',
        reasonCode: 'missing_code_or_provider_error',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(400).send({ error: 'Autenticazione fallita', reasonCode: 'auth_callback_failed' });
    }

    if (!rawTransientCookie) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'auth:callback',
        outcome: 'DENIED',
        reasonCode: 'transient_cookie_missing',
        channel: 'USER',
      });
      return reply.status(400).send({ error: 'Sessione di autenticazione mancante', reasonCode: 'auth_cookie_missing' });
    }

    // [P1 FIX] Valida rigorosamente la firma del cookie transitorio. Nessun fallback a cookie non firmati!
    const unsigned = req.unsignCookie(rawTransientCookie);
    if (!unsigned.valid || !unsigned.value) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'auth:callback',
        outcome: 'DENIED',
        reasonCode: 'transient_cookie_invalid_signature',
        channel: 'USER',
      });
      return reply.status(400).send({ error: 'Firma cookie transitorio non valida', reasonCode: 'auth_cookie_invalid_signature' });
    }

    let transientData: {
      state: unknown;
      codeVerifier: unknown;
      returnTo?: unknown;
      issuedAt: unknown;
    };
    try {
      transientData = JSON.parse(unsigned.value);
    } catch {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'auth:callback',
        outcome: 'DENIED',
        reasonCode: 'transient_cookie_malformed',
        channel: 'USER',
      });
      return reply.status(400).send({ error: 'Cookie transitorio malformato', reasonCode: 'auth_cookie_invalid' });
    }

    if (
      typeof transientData.state !== 'string' ||
      typeof transientData.codeVerifier !== 'string' ||
      transientData.state.length === 0 ||
      transientData.codeVerifier.length === 0
    ) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'auth:callback',
        outcome: 'DENIED',
        reasonCode: 'transient_cookie_invalid_payload',
        channel: 'USER',
      });
      return reply.status(400).send({
        error: 'Sessione transitoria non valida',
        reasonCode: 'auth_cookie_invalid',
      });
    }

    if (!isTransientIssuedAtValid(transientData.issuedAt)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'auth:callback',
        outcome: 'DENIED',
        reasonCode: 'transient_cookie_expired',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(400).send({
        error: 'Sessione transitoria scaduta',
        reasonCode: 'auth_cookie_expired',
      });
    }

    // Confronto timing-safe di state
    const stateValid =
      transientData.state &&
      transientData.state.length === query.state.length &&
      crypto.timingSafeEqual(Buffer.from(transientData.state), Buffer.from(query.state));

    if (!stateValid) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'auth:callback',
        outcome: 'DENIED',
        reasonCode: 'state_mismatch',
        channel: 'USER',
      });
      return reply.status(400).send({ error: 'Stato non valido (CSRF)', reasonCode: 'state_mismatch' });
    }

    try {
      const { sealedSession, session } = await identityProvider.exchangeCodeAndSealSession({
        code: query.code,
        codeVerifier: transientData.codeVerifier,
      });

      if (!session.emailVerified) {
        await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
          requestId: req.id || `req_${Date.now()}`,
          actorWorkosUserId: session.userId,
          action: 'auth:callback',
          outcome: 'DENIED',
          reasonCode: 'email_not_verified',
          channel: 'USER',
        });
        return reply.status(401).send({ error: 'Email non verificata su AuthKit', reasonCode: 'email_unverified' });
      }

      const emailNormalized = normalizeWorkosEmail(session.email);
      if (!emailNormalized || emailNormalized.length > 255) {
        await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
          requestId: req.id || `req_${Date.now()}`,
          actorWorkosUserId: session.userId,
          action: 'auth:callback',
          outcome: 'DENIED',
          reasonCode: 'verified_email_invalid',
          channel: 'USER',
        });
        return reply.status(401).send({
          error: 'Identità WorkOS non autorizzata',
          reasonCode: 'unauthorized_user',
        });
      }

      // Linking, riconciliazione e audit condividono la stessa transazione.
      const authResult = await prisma.$transaction(async (tx) => {
        let user = await tx.platformUser.findUnique({
          where: { workosUserId: session.userId },
        });
        const userByEmail = await tx.platformUser.findUnique({
          where: { emailNormalized },
        });
        const venue = session.organizationId
          ? await tx.venue.findUnique({
              where: { workosOrganizationId: session.organizationId },
              include: { onboarding: true },
            })
          : null;

        const deny = async (
          reasonCode: AuthAuditReasonCode,
          actorUserId?: string,
          venueId?: string
        ) => {
          await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
            requestId: req.id || `req_${Date.now()}`,
            actorUserId,
            actorWorkosUserId: session.userId,
            venueId,
            workosOrganizationId: session.organizationId || null,
            action: 'auth:callback',
            outcome: 'DENIED',
            reasonCode,
            channel: 'USER',
            originInfo: getAuditOriginInfo(req),
          });
          return { success: false as const, reason: 'unauthorized_user' };
        };

        if (session.organizationId && !venue) {
          return deny('organization_unknown_or_venue_inactive', user?.id);
        }

        const inactiveOnboardingVenue = Boolean(venue && !venue.isActive);
        if (
          inactiveOnboardingVenue &&
          (!venue?.onboarding || venue.onboarding.status === 'SUSPENDED')
        ) {
          return deny(
            'organization_unknown_or_venue_inactive',
            user?.id ?? userByEmail?.id,
            venue?.id
          );
        }

        if (
          inactiveOnboardingVenue &&
          (user?.platformRole === 'PLATFORM_ADMIN' ||
            userByEmail?.platformRole === 'PLATFORM_ADMIN')
        ) {
          return deny(
            'identity_link_collision_or_not_invited',
            user?.id ?? userByEmail?.id,
            venue?.id
          );
        }

        if (!user) {
          if (venue && !venue.isActive && !userByEmail) {
            const pendingOwnerInvitation = await tx.venueInvitation.findFirst({
              where: {
                venueId: venue.id,
                role: 'OWNER',
                status: { in: ['PENDING', 'SENT'] },
              },
              select: { id: true },
            });
            if (pendingOwnerInvitation) {
              await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
                requestId: req.id || `req_${Date.now()}`,
                actorWorkosUserId: session.userId,
                venueId: venue.id,
                workosOrganizationId: session.organizationId,
                action: 'invitation:email_mismatch',
                targetType: 'venue_invitation',
                targetId: pendingOwnerInvitation.id,
                outcome: 'DENIED',
                reasonCode: 'invitation_verified_email_mismatch',
                channel: 'USER',
                originInfo: getAuditOriginInfo(req),
              });
              return {
                success: false as const,
                reason: 'unauthorized_user',
              };
            }
          }
          if (!session.organizationId || !venue) {
            return deny('invited_user_organization_missing');
          }
          if (
            !userByEmail ||
            userByEmail.status !== 'INVITED' ||
            userByEmail.workosUserId !== null ||
            userByEmail.platformRole !== 'NONE'
          ) {
            return deny(
              userByEmail ? 'identity_link_collision_or_not_invited' : 'invited_user_not_found',
              userByEmail?.id,
              venue.id
            );
          }

          const pendingInvitation = !venue.isActive
            ? await tx.venueInvitation.findFirst({
                where: {
                  venueId: venue.id,
                  invitedEmailNormalized: emailNormalized,
                  status: { in: ['PENDING', 'SENT'] },
                  role: 'OWNER',
                  OR: [{ userId: null }, { userId: userByEmail.id }],
                  AND: [
                    {
                      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                    },
                  ],
                },
              })
            : null;

          const pendingMembership = await tx.venueMembership.findUnique({
            where: {
              userId_venueId: {
                userId: userByEmail.id,
                venueId: venue.id,
              },
            },
          });

          if (
            !pendingMembership ||
            pendingMembership.status !== 'PENDING' ||
            (!venue.isActive &&
              (pendingMembership.role !== 'OWNER' || !pendingInvitation))
          ) {
            return deny('pending_membership_not_found', userByEmail?.id, venue.id);
          }

          user = await tx.platformUser.update({
            where: { id: userByEmail!.id },
            data: {
              workosUserId: session.userId,
              emailNormalized,
              status: 'ACTIVE',
              lastReconciledAt: new Date(),
            },
          });

          await tx.venueMembership.update({
            where: { id: pendingMembership.id },
            data: { status: 'ACTIVE', activatedAt: new Date() },
          });

          if (!venue.isActive && pendingInvitation) {
            await tx.venueInvitation.update({
              where: { id: pendingInvitation.id },
              data: {
                status: 'ACCEPTED',
                acceptedAt: new Date(),
                userId: user.id,
              },
            });
          }

          if (!venue.isActive) {
            await updateOnboardingStateTx(tx, venue.id, {
              requestId: req.id,
              actorUserId: user.id,
            });
          }

          await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
            requestId: req.id || `req_${Date.now()}`,
            actorUserId: user.id,
            actorWorkosUserId: session.userId,
            venueId: venue.id,
            workosOrganizationId: session.organizationId,
            action: 'user:linked',
            outcome: 'SUCCESS',
            reasonCode: 'invited_user_linked',
            channel: 'USER',
            originInfo: getAuditOriginInfo(req),
          });
        } else {
          if (userByEmail && userByEmail.id !== user.id) {
            return deny('verified_email_collision', user.id, venue?.id);
          }
          if (user.status !== 'ACTIVE') {
            return deny('user_suspended_or_deprovisioned', user.id, venue?.id);
          }

          if (user.platformRole !== 'PLATFORM_ADMIN') {
            if (!venue) {
              return deny('organization_required_for_venue_user', user.id);
            }
            const membership = await tx.venueMembership.findUnique({
              where: {
                userId_venueId: {
                  userId: user.id,
                  venueId: venue.id,
                },
              },
            });

            if (!venue.isActive) {
              if (!membership || membership.role !== 'OWNER') {
                return deny('membership_inactive_or_not_found', user.id, venue.id);
              }

              const pendingInvitation = await tx.venueInvitation.findFirst({
                where: {
                  venueId: venue.id,
                  invitedEmailNormalized: emailNormalized,
                  role: 'OWNER',
                  status: { in: ['PENDING', 'SENT'] },
                  OR: [{ userId: null }, { userId: user.id }],
                  AND: [
                    {
                      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                    },
                  ],
                },
              });
              const acceptedInvitation = await tx.venueInvitation.findFirst({
                where: {
                  venueId: venue.id,
                  invitedEmailNormalized: emailNormalized,
                  role: 'OWNER',
                  status: 'ACCEPTED',
                  userId: user.id,
                },
              });

              if (
                membership.status === 'PENDING' &&
                pendingInvitation
              ) {
                await tx.venueMembership.update({
                  where: { id: membership.id },
                  data: { status: 'ACTIVE', activatedAt: new Date() },
                });
                await tx.venueInvitation.update({
                  where: { id: pendingInvitation.id },
                  data: {
                    status: 'ACCEPTED',
                    acceptedAt: new Date(),
                    userId: user.id,
                  },
                });
                await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
                  requestId: req.id || `req_${Date.now()}`,
                  actorUserId: user.id,
                  actorWorkosUserId: session.userId,
                  venueId: venue.id,
                  workosOrganizationId: session.organizationId,
                  action: 'membership:activated',
                  outcome: 'SUCCESS',
                  reasonCode: 'owner_invitation_accepted',
                  channel: 'USER',
                  originInfo: getAuditOriginInfo(req),
                });
                await updateOnboardingStateTx(tx, venue.id, {
                  requestId: req.id,
                  actorUserId: user.id,
                });
              } else if (
                membership.status !== 'ACTIVE' ||
                !acceptedInvitation
              ) {
                return deny('membership_inactive_or_not_found', user.id, venue.id);
              }
            } else if (!membership || membership.status !== 'ACTIVE') {
              return deny('membership_inactive_or_not_found', user.id, venue.id);
            }
          }

          user = await tx.platformUser.update({
            where: { id: user.id },
            data: {
              emailNormalized,
              lastReconciledAt: new Date(),
            },
          });
        }

        if (!user || user.status !== 'ACTIVE') {
          return deny('user_not_authorized_or_inactive', user?.id, venue?.id);
        }

        await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
          requestId: req.id || `req_${Date.now()}`,
          actorUserId: user.id,
          actorWorkosUserId: session.userId,
          workosOrganizationId: session.organizationId || null,
          action: 'user:login',
          outcome: 'SUCCESS',
          reasonCode: 'login_successful',
          channel: 'USER',
          sessionId: session.sessionId,
          originInfo: getAuditOriginInfo(req),
        });

        return { success: true as const, user };
      });

      if (!authResult.success) {
        return reply.status(401).send({ error: 'Utente non autorizzato o inattivo', reasonCode: authResult.reason });
      }

      setAuthCookie(reply, config, 'wos_session', sealedSession);

      const returnTo = normalizeConsoleReturnTo(transientData.returnTo);

      return reply.redirect(returnTo, 302);
    } catch {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'auth:callback',
        outcome: 'ERROR',
        reasonCode: 'code_exchange_failed',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(400).send({ error: 'Scambio codice fallito', reasonCode: 'code_exchange_error' });
    }
  });

  // GET /api/auth/csrf
  fastify.get('/api/auth/csrf', authRateLimitOptions, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;

    const csrfToken = crypto.randomBytes(24).toString('hex');
    setAuthCookie(reply, config, 'wos_csrf', csrfToken);

    return { csrfToken };
  });

  // POST /api/auth/switch-organization
  fastify.post('/api/auth/switch-organization', {
    ...authRateLimitOptions,
    preHandler: [sessionGuard],
    schema: {
      body: {
        type: 'object',
        required: ['organizationId'],
        additionalProperties: false,
        properties: {
          organizationId: { type: 'string' },
        },
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;

    if (!verifyCsrfToken(req, config)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user?.id,
        action: 'organization:switch',
        outcome: 'DENIED',
        reasonCode: 'csrf_validation_failed',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'CSRF token non valido', reasonCode: 'csrf_invalid' });
    }

    const { organizationId } = req.body as { organizationId: string };

    const targetVenue = await prisma.venue.findUnique({
      where: { workosOrganizationId: organizationId },
      include: { onboarding: true },
    });

    if (!targetVenue) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user!.id,
        workosOrganizationId: organizationId,
        action: 'organization:switch',
        outcome: 'DENIED',
        reasonCode: 'target_venue_not_found_or_inactive',
        channel: 'USER',
      });
      return reply.status(403).send({ error: 'Organizzazione o venue non valida', reasonCode: 'invalid_organization' });
    }

    const membership = await prisma.venueMembership.findUnique({
      where: {
        userId_venueId: {
          userId: req.user!.id,
          venueId: targetVenue.id,
        },
      },
    });

    const acceptedOwnerInvitation = !targetVenue.isActive
      ? await prisma.venueInvitation.findFirst({
          where: {
            venueId: targetVenue.id,
            invitedEmailNormalized: req.user!.emailNormalized,
            role: 'OWNER',
            status: 'ACCEPTED',
            userId: req.user!.id,
          },
        })
      : null;

    const isAllowedInactiveSwitch =
      !targetVenue.isActive &&
      Boolean(targetVenue.onboarding) &&
      targetVenue.onboarding?.status !== 'SUSPENDED' &&
      membership?.status === 'ACTIVE' &&
      membership?.role === 'OWNER' &&
      Boolean(acceptedOwnerInvitation);

    if (!targetVenue.isActive && !isAllowedInactiveSwitch) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user!.id,
        workosOrganizationId: organizationId,
        action: 'organization:switch',
        outcome: 'DENIED',
        reasonCode: 'target_venue_not_found_or_inactive',
        channel: 'USER',
      });
      return reply.status(403).send({ error: 'Organizzazione o venue non valida', reasonCode: 'invalid_organization' });
    }

    if (!membership || membership.status !== 'ACTIVE') {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user!.id,
        venueId: targetVenue.id,
        workosOrganizationId: organizationId,
        action: 'organization:switch',
        outcome: 'DENIED',
        reasonCode: 'membership_inactive_or_not_found',
        channel: 'USER',
      });
      return reply.status(403).send({ error: 'Membership non attiva per questa venue', reasonCode: 'membership_inactive' });
    }

    const sessionCookieName = (config.IS_PRODUCTION ? '__Host-' : '') + 'wos_session';
    const sealedCookie = req.cookies[sessionCookieName];
    const unsigned = req.unsignCookie(sealedCookie || '');
    if (!unsigned.valid || !unsigned.value) {
      clearAuthCookie(reply, config, 'wos_session');
      return reply.status(401).send({
        error: 'Sessione non valida',
        reasonCode: 'invalid_cookie_signature',
      });
    }
    const sealedSession = unsigned.value;

    const refreshed = await identityProvider.refreshSealedSession(sealedSession, organizationId);
    if (
      !refreshed ||
      !refreshed.session.emailVerified ||
      refreshed.session.userId !== req.user!.workosUserId ||
      refreshed.session.organizationId !== organizationId ||
      normalizeWorkosEmail(refreshed.session.email) !==
        req.user!.emailNormalized
    ) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user!.id,
        workosOrganizationId: organizationId,
        action: 'organization:switch',
        outcome: 'ERROR',
        reasonCode: 'provider_refresh_mismatch_or_failed',
        channel: 'USER',
      });
      return reply.status(400).send({ error: 'Cambio organizzazione non valido su AuthKit', reasonCode: 'switch_failed' });
    }

    setAuthCookie(reply, config, 'wos_session', refreshed.sealedSession);

    await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
      requestId: req.id || `req_${Date.now()}`,
      actorUserId: req.user!.id,
      actorWorkosUserId: req.user!.workosUserId,
      venueId: targetVenue.id,
      workosOrganizationId: organizationId,
      action: 'organization:switch',
      outcome: 'SUCCESS',
      reasonCode: 'organization_switched',
      channel: 'USER',
      sessionId: refreshed.session.sessionId,
      originInfo: getAuditOriginInfo(req),
    });

    return { status: 'ok', organizationId };
  });

  // POST /api/auth/logout
  fastify.post('/api/auth/logout', {
    ...authRateLimitOptions,
    preHandler: [sessionGuard],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;

    if (!verifyCsrfToken(req, config)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user?.id,
        action: 'user:logout',
        outcome: 'DENIED',
        reasonCode: 'csrf_validation_failed',
        channel: 'USER',
      });
      return reply.status(403).send({ error: 'CSRF token non valido', reasonCode: 'csrf_invalid' });
    }

    // [P1 FIX] Cancella cookie con Secure ed elabora LogoutURL reale da AuthKit con sessionId
    clearAuthCookie(reply, config, 'wos_session');
    clearAuthCookie(reply, config, 'wos_csrf');
    clearAuthCookie(reply, config, 'wos_transient');

    await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
      requestId: req.id || `req_${Date.now()}`,
      actorUserId: req.user?.id,
      actorWorkosUserId: req.user?.workosUserId,
      action: 'user:logout',
      outcome: 'SUCCESS',
      reasonCode: 'user_logged_out',
      channel: 'USER',
      sessionId: req.workosSession?.sessionId,
      originInfo: getAuditOriginInfo(req),
    });

    const logoutOpts: { sessionId: string; postLogoutRedirectUri: string } = {
      sessionId: req.workosSession!.sessionId,
      postLogoutRedirectUri: config.WORKOS_POST_LOGOUT_REDIRECT_URI,
    };
    const logoutUrl = identityProvider.getLogoutUrl(logoutOpts);

    return { status: 'ok', logoutUrl };
  });

  // GET /api/console/me
  fastify.get('/api/console/me', {
    preHandler: [sessionGuard],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;

    const memberships = await prisma.venueMembership.findMany({
      where: { userId: req.user!.id, status: 'ACTIVE' },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            workosOrganizationId: true,
            isActive: true,
            onboarding: { select: { status: true } },
          },
        },
      },
    });

    const activeMemberships = memberships
      .filter((m) => m.venue.isActive)
      .map((m) => ({
        venueId: m.venue.id,
        venueName: m.venue.name,
        organizationId: m.venue.workosOrganizationId,
        role: m.role,
      }));

    const onboardingVenues = memberships
      .filter((m) => !m.venue.isActive && m.role === 'OWNER' && m.venue.onboarding?.status !== 'SUSPENDED')
      .map((m) => ({
        venueId: m.venue.id,
        venueName: m.venue.name,
        organizationId: m.venue.workosOrganizationId,
        role: m.role,
        onboardingStatus: m.venue.onboarding?.status || 'DRAFT',
      }));

    return {
      user: {
        id: req.user!.id,
        email: req.user!.emailNormalized,
        platformRole: req.user!.platformRole,
      },
      currentOrganizationId: req.workosSession?.organizationId || null,
      memberships: activeMemberships,
      onboardingVenues,
    };
  });

  // GET /api/console/venue
  fastify.get('/api/console/venue', {
    preHandler: [sessionGuard, venueReadGuard],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;

    return {
      venue: {
        id: req.currentVenue!.id,
        name: req.currentVenue!.name,
        role: req.membership!.role,
        permissions: Array.from(getVenuePermissions(req.membership!.role)),
      },
    };
  });

  // GET /api/platform/venues
  fastify.get('/api/platform/venues', {
    preHandler: [sessionGuard, platformVenuesGuard],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;

    const venues = await prisma.venue.findMany({
      select: {
        id: true,
        name: true,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return { venues };
  });
}
