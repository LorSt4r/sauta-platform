import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient, PlatformUser, Venue, VenueMembership } from '@prisma/client';
import type { AppConfig } from '../utils/config';
import type { IdentityProvider, WorkosNormalizedSession } from '../utils/identityProvider';
import { hasPlatformPermission, hasVenuePermission, type PlatformPermission, type VenuePermission } from '../utils/rbac';
import { logAuthAuditEvent } from '../utils/auditLogger';
import crypto from 'node:crypto';
import { parseHostAuthority } from '../utils/hostAuthority';

declare module 'fastify' {
  interface FastifyRequest {
    user?: PlatformUser;
    workosSession?: WorkosNormalizedSession;
    currentVenue?: Venue;
    membership?: VenueMembership;
  }
}

export function getAuditOriginInfo(req: FastifyRequest): {
  ip?: string;
  userAgent?: string;
} {
  const userAgent = req.headers['user-agent'];
  return {
    ip: req.ip,
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
  };
}

export function getCookieName(config: AppConfig, baseName: string): string {
  if (config.IS_PRODUCTION) {
    return `__Host-${baseName}`;
  }
  return baseName;
}

export function clearAuthCookie(reply: FastifyReply, config: AppConfig, baseName: string): void {
  const cookieName = getCookieName(config, baseName);
  reply.clearCookie(cookieName, {
    path: '/',
    secure: config.IS_PRODUCTION,
    sameSite: 'lax',
  });
}

export function setAuthCookie(
  reply: FastifyReply,
  config: AppConfig,
  baseName: string,
  value: string,
  options: { maxAge?: number } = {}
): void {
  const cookieName = getCookieName(config, baseName);
  const cookieOpts: Parameters<FastifyReply['setCookie']>[2] = {
    path: '/',
    httpOnly: true,
    secure: config.IS_PRODUCTION,
    sameSite: 'lax',
    signed: true,
  };
  if (options.maxAge !== undefined) {
    cookieOpts.maxAge = options.maxAge;
  }
  reply.setCookie(cookieName, value, cookieOpts);
}

export function getRequestHost(req: FastifyRequest, config: AppConfig): string {
  const hostResult = parseHostAuthority(req.headers.host, config);
  return hostResult.hostname;
}

export function getRequestHostname(req: FastifyRequest, config: AppConfig): string {
  return getRequestHost(req, config);
}

export function verifyCsrfToken(req: FastifyRequest, config: AppConfig): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin !== config.CONSOLE_ORIGIN) {
    return false;
  }

  const csrfHeader = req.headers['x-csrf-token'];
  if (!csrfHeader || typeof csrfHeader !== 'string') {
    return false;
  }

  const cookieName = getCookieName(config, 'wos_csrf');
  const signedCookie = req.cookies[cookieName];
  if (!signedCookie) return false;

  const unsigned = req.unsignCookie(signedCookie);
  if (!unsigned.valid || !unsigned.value) return false;

  const headerBuf = Buffer.from(csrfHeader);
  const cookieBuf = Buffer.from(unsigned.value);

  // Previene RangeError se i buffer hanno lunghezza diversa prima di timingSafeEqual
  if (headerBuf.length !== cookieBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(headerBuf, cookieBuf);
}

export function createSessionGuard(
  prisma: PrismaClient,
  config: AppConfig,
  identityProvider: IdentityProvider
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // 1. Verfica origin / Host console (rispetta TRUST_PROXY!)
    const reqHostname = getRequestHostname(req, config);
    const consoleHostname = new URL(config.CONSOLE_ORIGIN).hostname;
    if (reqHostname !== consoleHostname) {
      return reply.status(404).send({ error: 'Not Found' });
    }

    const sessionCookieName = getCookieName(config, 'wos_session');
    const sealedCookie = req.cookies[sessionCookieName];

    if (!sealedCookie) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'session:authenticate',
        outcome: 'DENIED',
        reasonCode: 'missing_session_cookie',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(401).send({ error: 'Non autorizzato', reasonCode: 'missing_session' });
    }

    // Unsign cookie (MANDATORIO: se firma non valida o mancante, REJECT IMMEDIATAMENTE!)
    const unsigned = req.unsignCookie(sealedCookie);
    if (!unsigned.valid || !unsigned.value) {
      clearAuthCookie(reply, config, 'wos_session');
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'session:authenticate',
        outcome: 'DENIED',
        reasonCode: 'session_cookie_invalid_signature',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(401).send({ error: 'Firma cookie sessione non valida', reasonCode: 'invalid_cookie_signature' });
    }

    const sealedSession = unsigned.value;
    let normSession = await identityProvider.authenticateSealedSession(sealedSession);

    // Tentativo di refresh se la sessione è scaduta o invalida
    if (!normSession) {
      const refreshed = await identityProvider.refreshSealedSession(sealedSession);
      if (refreshed) {
        normSession = refreshed.session;
        setAuthCookie(reply, config, 'wos_session', refreshed.sealedSession);
      } else {
        clearAuthCookie(reply, config, 'wos_session');
        await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
          requestId: req.id || `req_${Date.now()}`,
          action: 'session:authenticate',
          outcome: 'DENIED',
          reasonCode: 'invalid_or_expired_session',
          channel: 'USER',
          originInfo: getAuditOriginInfo(req),
        });
        return reply.status(401).send({ error: 'Sessione scaduta o non valida', reasonCode: 'session_expired' });
      }
    }

    if (!normSession.emailVerified) {
      clearAuthCookie(reply, config, 'wos_session');
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorWorkosUserId: normSession.userId,
        action: 'session:authenticate',
        outcome: 'DENIED',
        reasonCode: 'email_unverified_session',
        channel: 'USER',
        sessionId: normSession.sessionId,
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(401).send({
        error: 'Identità non verificata',
        reasonCode: 'email_unverified',
      });
    }

    // Carica utente locale da DB
    const platformUser = await prisma.platformUser.findUnique({
      where: { workosUserId: normSession.userId },
    });

    if (
      !platformUser ||
      platformUser.status !== 'ACTIVE' ||
      normSession.email.trim().toLowerCase() !== platformUser.emailNormalized
    ) {
      clearAuthCookie(reply, config, 'wos_session');
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorWorkosUserId: normSession.userId,
        action: 'session:authenticate',
        outcome: 'DENIED',
        reasonCode: platformUser
          ? 'verified_email_session_mismatch'
          : 'user_inactive_or_not_found',
        channel: 'USER',
        sessionId: normSession.sessionId,
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(401).send({ error: 'Utente non attivo o non autorizzato', reasonCode: 'user_inactive' });
    }

    req.user = platformUser;
    req.workosSession = normSession;
  };
}

export function createPlatformGuard(
  permission: PlatformPermission,
  prisma: PrismaClient,
  config: AppConfig
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return reply.status(401).send({ error: 'Non autorizzato' });
    }

    if (!hasPlatformPermission(req.user.platformRole, permission)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user.id,
        actorWorkosUserId: req.user.workosUserId,
        action: 'platform:access',
        permission,
        outcome: 'DENIED',
        reasonCode: 'insufficient_platform_permission',
        channel: 'USER',
        sessionId: req.workosSession?.sessionId,
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'Permesso piattaforma negato', reasonCode: 'forbidden' });
    }
  };
}

export function createVenueGuard(
  permission: VenuePermission,
  prisma: PrismaClient,
  config: AppConfig
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !req.workosSession) {
      return reply.status(401).send({ error: 'Non autorizzato' });
    }

    const orgId = req.workosSession.organizationId;
    if (!orgId) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user.id,
        actorWorkosUserId: req.user.workosUserId,
        action: 'venue:access',
        permission,
        outcome: 'DENIED',
        reasonCode: 'no_organization_selected',
        channel: 'USER',
        sessionId: req.workosSession.sessionId,
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'Nessuna organizzazione selezionata', reasonCode: 'no_organization' });
    }

    const venue = await prisma.venue.findUnique({
      where: { workosOrganizationId: orgId },
    });

    if (!venue || !venue.isActive) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user.id,
        actorWorkosUserId: req.user.workosUserId,
        workosOrganizationId: orgId,
        action: 'venue:access',
        permission,
        outcome: 'DENIED',
        reasonCode: 'venue_inactive_or_not_found',
        channel: 'USER',
        sessionId: req.workosSession.sessionId,
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(404).send({ error: 'Venue non trovata o non attiva', reasonCode: 'venue_not_found' });
    }

    const membership = await prisma.venueMembership.findUnique({
      where: {
        userId_venueId: {
          userId: req.user.id,
          venueId: venue.id,
        },
      },
    });

    if (!membership || membership.status !== 'ACTIVE' || !hasVenuePermission(membership.role, permission)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user.id,
        actorWorkosUserId: req.user.workosUserId,
        venueId: venue.id,
        workosOrganizationId: orgId,
        action: 'venue:access',
        permission,
        outcome: 'DENIED',
        reasonCode: 'insufficient_venue_permission',
        channel: 'USER',
        sessionId: req.workosSession.sessionId,
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'Permesso locale negato per questa venue', reasonCode: 'forbidden' });
    }

    req.currentVenue = venue;
    req.membership = membership;
  };
}

export function createVenueOnboardingGuard(
  prisma: PrismaClient,
  config: AppConfig
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !req.workosSession) {
      return reply.status(401).send({ error: 'Non autorizzato' });
    }

    const hostResult = parseHostAuthority(req.headers.host, config);
    if (hostResult.type !== 'CONSOLE') {
      return reply.status(404).send({ error: 'Not Found' });
    }

    const orgId = req.workosSession.organizationId;
    if (!orgId) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user.id,
        actorWorkosUserId: req.user.workosUserId,
        action: 'onboarding:access',
        permission: 'venue:manage',
        outcome: 'DENIED',
        reasonCode: 'no_organization_selected',
        channel: 'USER',
        sessionId: req.workosSession.sessionId,
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'Nessuna organizzazione selezionata', reasonCode: 'no_organization' });
    }

    const venue = await prisma.venue.findUnique({
      where: { workosOrganizationId: orgId },
      include: { onboarding: true },
    });

    if (!venue) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user.id,
        actorWorkosUserId: req.user.workosUserId,
        workosOrganizationId: orgId,
        action: 'onboarding:access',
        permission: 'venue:manage',
        outcome: 'DENIED',
        reasonCode: 'venue_not_found',
        channel: 'USER',
        sessionId: req.workosSession.sessionId,
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(404).send({ error: 'Venue non trovata', reasonCode: 'venue_not_found' });
    }

    if (!venue.onboarding || venue.onboarding.status === 'SUSPENDED') {
      const reasonCode = venue.onboarding ? 'onboarding_suspended' : 'onboarding_not_initialized';
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user.id,
        actorWorkosUserId: req.user.workosUserId,
        venueId: venue.id,
        workosOrganizationId: orgId,
        action: 'onboarding:access',
        permission: 'venue:manage',
        outcome: 'DENIED',
        reasonCode,
        channel: 'USER',
        sessionId: req.workosSession.sessionId,
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({
        error: venue.onboarding ? 'Onboarding venue sospeso' : 'Onboarding venue non inizializzato',
        reasonCode,
      });
    }

    const membership = await prisma.venueMembership.findUnique({
      where: {
        userId_venueId: {
          userId: req.user.id,
          venueId: venue.id,
        },
      },
    });

    if (!membership || membership.status !== 'ACTIVE' || membership.role !== 'OWNER') {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user.id,
        actorWorkosUserId: req.user.workosUserId,
        venueId: venue.id,
        workosOrganizationId: orgId,
        action: 'onboarding:access',
        permission: 'venue:manage',
        outcome: 'DENIED',
        reasonCode: 'insufficient_onboarding_owner_permission',
        channel: 'USER',
        sessionId: req.workosSession.sessionId,
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'Soltanto l\'OWNER attivo può accedere all\'onboarding', reasonCode: 'forbidden' });
    }

    req.currentVenue = venue;
    req.membership = membership;
  };
}
