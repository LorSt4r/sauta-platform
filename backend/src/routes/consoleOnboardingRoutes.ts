import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../utils/config';
import type { IdentityProvider } from '../utils/identityProvider';
import {
  createSessionGuard,
  createVenueOnboardingGuard,
  verifyCsrfToken,
  getRequestHostname,
  getAuditOriginInfo,
} from './authGuards';
import { updateOnboardingStateTx } from '../services/identityProvisioningService';
import { evaluateVenueReadiness } from '../services/onboardingStateMachine';
import { logAuthAuditEvent } from '../utils/auditLogger';

export async function registerConsoleOnboardingRoutes(
  fastify: FastifyInstance,
  opts: {
    prisma: PrismaClient;
    config: AppConfig;
    identityProvider: IdentityProvider;
  }
) {
  const { prisma, config, identityProvider } = opts;
  const sessionGuard = createSessionGuard(prisma, config, identityProvider);
  const onboardingGuard = createVenueOnboardingGuard(prisma, config);

  const consoleHostname = new URL(config.CONSOLE_ORIGIN).hostname;
  const mutationRateLimit = {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
      },
    },
  };

  const requireConsoleHost = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const reqHostname = getRequestHostname(req, config);
    if (reqHostname !== consoleHostname) {
      reply.status(404).send({ error: 'Not Found' });
      return false;
    }
    return true;
  };

  // GET /api/console/onboarding
  fastify.get('/api/console/onboarding', {
    preHandler: [sessionGuard, onboardingGuard],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;

    const venue = await prisma.venue.findUnique({
      where: { id: req.currentVenue!.id },
      include: {
        onboarding: true,
        onboardingSteps: true,
        domains: true,
        products: true,
        memberships: { include: { user: true } },
        invitations: true,
      },
    });

    if (!venue) {
      return reply.status(404).send({ error: 'Venue non trovata', reasonCode: 'venue_not_found' });
    }

    const hasActiveOwner = venue.memberships.some(
      (m) => m.role === 'OWNER' && m.status === 'ACTIVE' && m.user.status === 'ACTIVE'
    );
    const hasVerifiedPlatformDomain = venue.domains.some(
      (d) => d.type === 'PLATFORM' && d.status === 'VERIFIED' && d.isPrimary
    );
    const hasValidCatalog = venue.products.some((p) => p.active && p.price > 0 && p.vatRate >= 0);
    const legalInfoComplete = Boolean(
      venue.vatNumber && venue.fiscalAddress && venue.fiscalCity && venue.fiscalZip
    );

    const legalStepRecord = venue.onboardingSteps.find((s) => s.step === 'LEGAL');
    const opsStepRecord = venue.onboardingSteps.find((s) => s.step === 'OPERATIONS');

    const legalReviewed = legalStepRecord?.source === 'PLATFORM_REVIEW' && legalStepRecord.status === 'READY';
    const operationsReviewed = opsStepRecord?.source === 'PLATFORM_REVIEW' && opsStepRecord.status === 'READY';
    const stripeStepRecord = venue.onboardingSteps.find((s) => s.step === 'STRIPE');
    const fiscalStepRecord = venue.onboardingSteps.find((s) => s.step === 'FISCAL');
    const stripeReady =
      stripeStepRecord?.source === 'PROVIDER' &&
      stripeStepRecord.status === 'READY';
    const fiscalReady =
      fiscalStepRecord?.source === 'PROVIDER' &&
      fiscalStepRecord.status === 'READY';
    const workosOrganizationMapped = Boolean(venue.workosOrganizationId);

    const facts = {
      venueId: venue.id,
      onboardingStatus: venue.onboarding?.status || 'DRAFT',
      isActive: venue.isActive,
      hasActiveOwner,
      hasVerifiedPlatformDomain,
      hasValidCatalog,
      legalInfoComplete,
      legalReviewed,
      operationsReviewed,
      stripeReady,
      fiscalReady,
      workosOrganizationMapped,
    };

    const readiness = evaluateVenueReadiness(facts);

    return {
      venue: {
        id: venue.id,
        name: venue.name,
        vatNumber: venue.vatNumber,
        fiscalAddress: venue.fiscalAddress,
        fiscalCity: venue.fiscalCity,
        fiscalZip: venue.fiscalZip,
        isActive: venue.isActive,
      },
      onboardingStatus: venue.onboarding?.status || 'DRAFT',
      steps: venue.onboardingSteps.map((s) => ({
        step: s.step,
        status: s.status,
        source: s.source,
        reasonCode: s.reasonCode,
        completedAt: s.completedAt,
      })),
      readiness,
    };
  });

  // PATCH /api/console/onboarding/profile (Allowlisted fields ONLY)
  fastify.patch('/api/console/onboarding/profile', {
    ...mutationRateLimit,
    preHandler: [sessionGuard, onboardingGuard],
    schema: {
      body: {
        type: 'object',
        additionalProperties: false, // Strict allowlist check
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          vatNumber: { type: 'string', minLength: 5, maxLength: 32 },
          fiscalAddress: { type: 'string', minLength: 1, maxLength: 255 },
          fiscalCity: { type: 'string', minLength: 1, maxLength: 128 },
          fiscalZip: { type: 'string', minLength: 1, maxLength: 32 },
        },
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;

    if (!verifyCsrfToken(req, config)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user?.id,
        action: 'onboarding:profile_update',
        outcome: 'DENIED',
        reasonCode: 'csrf_validation_failed',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'CSRF token non valido', reasonCode: 'csrf_invalid' });
    }

    const body = req.body as {
      name?: string;
      vatNumber?: string;
      fiscalAddress?: string;
      fiscalCity?: string;
      fiscalZip?: string;
    };

    const updateData: Record<string, string> = {};
    if (body.name !== undefined) updateData.name = body.name.trim();
    if (body.vatNumber !== undefined) updateData.vatNumber = body.vatNumber.trim().toUpperCase();
    if (body.fiscalAddress !== undefined) updateData.fiscalAddress = body.fiscalAddress.trim();
    if (body.fiscalCity !== undefined) updateData.fiscalCity = body.fiscalCity.trim();
    if (body.fiscalZip !== undefined) updateData.fiscalZip = body.fiscalZip.trim();

    if (Object.keys(updateData).length === 0) {
      return reply.status(400).send({ error: 'Nessun campo valido fornito per l\'aggiornamento', reasonCode: 'empty_update' });
    }
    if (Object.values(updateData).some((value) => value.length === 0)) {
      return reply.status(400).send({
        error: 'I campi aggiornati non possono essere vuoti',
        reasonCode: 'blank_profile_field',
      });
    }

    const venueId = req.currentVenue!.id;

    await prisma.$transaction(async (tx) => {
      await tx.venue.update({
        where: { id: venueId },
        data: updateData,
      });

      await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user!.id,
        actorWorkosUserId: req.user!.workosUserId,
        venueId,
        action: 'onboarding:step_updated',
        outcome: 'SUCCESS',
        reasonCode: 'profile_fields_updated',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });

      await updateOnboardingStateTx(tx, venueId, {
        requestId: req.id,
        actorUserId: req.user!.id,
      });
    });

    const updatedVenue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        id: true,
        name: true,
        vatNumber: true,
        fiscalAddress: true,
        fiscalCity: true,
        fiscalZip: true,
        onboarding: { select: { status: true } },
      },
    });

    return reply.status(200).send({
      status: 'ok',
      venue: updatedVenue,
      onboardingStatus: updatedVenue?.onboarding?.status || 'DRAFT',
    });
  });
}
