import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  Prisma,
  type IdentityProvisioningCommand,
  type PrismaClient,
  type PlatformUser,
} from '@prisma/client';
import type { AppConfig } from '../utils/config';
import type { IdentityProvider } from '../utils/identityProvider';
import { createSessionGuard, createPlatformGuard, getRequestHostname, verifyCsrfToken, getAuditOriginInfo } from './authGuards';
import {
  executeIdentityProvisioningCommand,
  reconcileIdentityProvisioning,
  updateOnboardingStateTx,
} from '../services/identityProvisioningService';
import { evaluateAllSteps, evaluateVenueReadiness } from '../services/onboardingStateMachine';
import {
  logAuthAuditEvent,
  type AuthAuditReasonCode,
} from '../utils/auditLogger';
import {
  computeIdempotencyDedupKey,
  computeRequestHash,
  isValidIdempotencyKey,
} from '../utils/idempotency';

export async function registerPlatformOnboardingRoutes(
  fastify: FastifyInstance,
  opts: {
    prisma: PrismaClient;
    config: AppConfig;
    identityProvider: IdentityProvider;
  }
) {
  const { prisma, config, identityProvider } = opts;
  const sessionGuard = createSessionGuard(prisma, config, identityProvider);
  const manageVenuesGuard = createPlatformGuard('platform:venues:manage', prisma, config);
  const reviewOnboardingGuard = createPlatformGuard('platform:onboarding:review', prisma, config);
  const manageInvitationsGuard = createPlatformGuard('platform:invitations:manage', prisma, config);
  const mutationRateLimit = {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  };

  const consoleHostname = new URL(config.CONSOLE_ORIGIN).hostname;

  const requireConsoleHost = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const reqHostname = getRequestHostname(req, config);
    if (reqHostname !== consoleHostname) {
      reply.status(404).send({ error: 'Not Found' });
      return false;
    }
    return true;
  };

  const validateIdempotencyKey = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const rawKey = req.headers['idempotency-key'];
    if (!rawKey || typeof rawKey !== 'string') {
      reply.status(400).send({ error: 'Header Idempotency-Key obbligatorio per mutazioni platform', reasonCode: 'idempotency_key_missing' });
      return null;
    }
    const key = rawKey.trim();
    if (!isValidIdempotencyKey(key)) {
      reply.status(400).send({ error: 'Header Idempotency-Key non valido', reasonCode: 'idempotency_key_invalid' });
      return null;
    }
    return key;
  };

  const computeDedupKey = (req: FastifyRequest, rawKey: string): string => {
    const routePath = req.routeOptions.url ?? req.url;
    return computeIdempotencyDedupKey(
      routePath,
      req.user?.id || 'anonymous',
      rawKey
    );
  };

  const getRoutePath = (req: FastifyRequest): string =>
    req.routeOptions.url ?? req.url;

  const isUniqueViolation = (err: unknown): boolean => {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  };

  const ownerIdentityConflict = (user: PlatformUser): boolean => {
    if (user.platformRole !== 'NONE') return true;
    return !(
      (user.status === 'INVITED' && user.workosUserId === null) ||
      (user.status === 'ACTIVE' && user.workosUserId !== null)
    );
  };

  const sendReceiptReplay = async (
    reply: FastifyReply,
    dedupKey: string,
    requestHash: string
  ): Promise<boolean> => {
    const receipt = await prisma.platformMutationReceipt.findUnique({
      where: { dedupKey },
    });
    if (!receipt) return false;
    if (receipt.requestHash !== requestHash) {
      reply.status(409).send({
        error: 'Stessa Idempotency-Key utilizzata con payload differente',
        reasonCode: 'idempotency_key_payload_mismatch',
      });
      return true;
    }
    const body =
      receipt.responseBody &&
      typeof receipt.responseBody === 'object' &&
      !Array.isArray(receipt.responseBody)
        ? { ...(receipt.responseBody as Record<string, unknown>), idempotentReplay: true }
        : { result: receipt.responseBody, idempotentReplay: true };
    reply.status(receipt.responseStatus).send(body);
    return true;
  };

  const sendCommandResult = (
    reply: FastifyReply,
    command: IdentityProvisioningCommand,
    invitationId: string,
    idempotentReplay = false
  ) => {
    const common = {
      invitationId,
      commandId: command.id,
      commandStatus: command.status,
      reasonCode: command.lastReasonCode,
      ...(idempotentReplay ? { idempotentReplay: true } : {}),
    };
    if (command.status === 'SUCCEEDED') {
      return reply.status(200).send({ status: 'ok', ...common });
    }
    if (command.status === 'PENDING' || command.status === 'PROCESSING') {
      return reply.status(202).send({
        status: command.status.toLowerCase(),
        ...common,
      });
    }
    return reply.status(400).send({
      error: 'Operazione di provisioning non completata',
      status: command.status.toLowerCase(),
      ...common,
    });
  };

  // POST /api/platform/venues
  fastify.post('/api/platform/venues', {
    ...mutationRateLimit,
    preHandler: [sessionGuard, manageVenuesGuard],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'slug', 'ownerEmail'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          slug: { type: 'string', minLength: 3, maxLength: 63, pattern: '^[a-z0-9-]+$' },
          ownerEmail: { type: 'string', minLength: 3, maxLength: 255 },
        },
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;
    if (!verifyCsrfToken(req, config)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user?.id,
        actorWorkosUserId: req.user?.workosUserId,
        action: 'venue:draft_created',
        outcome: 'DENIED',
        reasonCode: 'csrf_validation_failed',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'CSRF token non valido', reasonCode: 'csrf_invalid' });
    }

    const idempotencyKey = validateIdempotencyKey(req, reply);
    if (!idempotencyKey) return;

    const { name: rawName, slug: rawSlug, ownerEmail: rawEmail } = req.body as {
      name: string;
      slug: string;
      ownerEmail: string;
    };

    const name = rawName.trim();
    const slug = rawSlug.trim().toLowerCase();
    const ownerEmail = rawEmail.trim().toLowerCase();

    if (!name) {
      return reply.status(400).send({
        error: 'Nome venue non valido',
        reasonCode: 'invalid_venue_name',
      });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      return reply.status(400).send({ error: 'Email non valida', reasonCode: 'invalid_email' });
    }

    const dedupKey = computeDedupKey(req, idempotencyKey);
    const requestHash = computeRequestHash({ name, slug, ownerEmail });

    // Check if command with dedupKey already exists for idempotency
    const existingCmd = await prisma.identityProvisioningCommand.findUnique({
      where: { dedupKey },
      include: { venue: { include: { domains: true } } },
    });

    if (existingCmd) {
      if (existingCmd.requestHash !== requestHash) {
        return reply.status(409).send({
          error: 'Stessa Idempotency-Key utilizzata con payload differente',
          reasonCode: 'idempotency_key_payload_mismatch',
        });
      }

      const primaryDomain = existingCmd.venue.domains.find((d) => d.isPrimary);

      return reply.status(200).send({
        venueId: existingCmd.venue.id,
        name: existingCmd.venue.name,
        slug,
        hostname: primaryDomain?.hostname || `${slug}.${config.PLATFORM_ROOT_DOMAIN}`,
        ownerEmail,
        onboardingStatus: 'DRAFT',
        provisioningCommandId: existingCmd.id,
        idempotentReplay: true,
      });
    }

    const hostname = `${slug}.${config.PLATFORM_ROOT_DOMAIN}`;
    if (hostname === consoleHostname) {
      return reply.status(409).send({
        error: 'Hostname riservato alla console',
        reasonCode: 'reserved_platform_hostname',
      });
    }

    const existingOwner = await prisma.platformUser.findUnique({
      where: { emailNormalized: ownerEmail },
    });
    if (existingOwner && ownerIdentityConflict(existingOwner)) {
      return reply.status(409).send({
        error: 'Identità OWNER in conflitto',
        reasonCode: 'owner_identity_conflict',
      });
    }

    // Check hostname / slug availability
    const existingDomain = await prisma.venueDomain.findUnique({ where: { hostname } });
    if (existingDomain) {
      return reply.status(409).send({ error: 'Hostname platform già in uso', reasonCode: 'hostname_already_exists' });
    }

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
      // 1. Create Venue
      const venue = await tx.venue.create({
        data: {
          name,
          isActive: false,
        },
      });

      // 2. Create primary VenueDomain (R4: PENDING status)
      const domain = await tx.venueDomain.create({
        data: {
          venueId: venue.id,
          hostname,
          type: 'PLATFORM',
          status: 'PENDING',
          isPrimary: true,
          verifiedAt: null,
        },
      });

      // 3. Create VenueOnboarding aggregate
      const onboarding = await tx.venueOnboarding.create({
        data: {
          venueId: venue.id,
          status: 'DRAFT',
        },
      });

      // 4. Create all 7 VenueOnboardingStep records
      const initialSteps = [
        {
          step: 'OWNER',
          status: 'IN_PROGRESS',
          source: 'SYSTEM',
          reasonCode: 'missing_owner_membership',
        },
        {
          step: 'LEGAL',
          status: 'IN_PROGRESS',
          source: 'OWNER',
          reasonCode: 'legal_info_incomplete',
        },
        {
          step: 'DOMAIN',
          status: 'IN_PROGRESS',
          source: 'SYSTEM',
          reasonCode: 'unverified_platform_domain',
        },
        {
          step: 'CATALOG',
          status: 'NOT_STARTED',
          source: 'OWNER',
          reasonCode: 'missing_catalog_products',
        },
        {
          step: 'STRIPE',
          status: 'BLOCKED',
          source: 'PROVIDER',
          reasonCode: 'stripe_not_ready',
        },
        {
          step: 'FISCAL',
          status: 'BLOCKED',
          source: 'PROVIDER',
          reasonCode: 'fiscal_not_ready',
        },
        {
          step: 'OPERATIONS',
          status: 'BLOCKED',
          source: 'PLATFORM_REVIEW',
          reasonCode: 'operations_review_required',
        },
      ] as const;

      for (const initialStep of initialSteps) {
        await tx.venueOnboardingStep.create({
          data: {
            venueId: venue.id,
            ...initialStep,
          },
        });
      }

      // 5. Upsert PlatformUser for ownerEmail
      let ownerUser = await tx.platformUser.findUnique({
        where: { emailNormalized: ownerEmail },
      });

      if (!ownerUser) {
        ownerUser = await tx.platformUser.create({
          data: {
            emailNormalized: ownerEmail,
            status: 'INVITED',
            platformRole: 'NONE',
          },
        });
      }
      if (ownerIdentityConflict(ownerUser)) {
        throw new Error('owner_identity_conflict');
      }

      // 6. Create VenueMembership (PENDING)
      const membership = await tx.venueMembership.upsert({
        where: {
          userId_venueId: {
            userId: ownerUser.id,
            venueId: venue.id,
          },
        },
        create: {
          userId: ownerUser.id,
          venueId: venue.id,
          role: 'OWNER',
          status: 'PENDING',
        },
        update: {
          role: 'OWNER',
          status: 'PENDING',
        },
      });

      // 7. Create VenueInvitation (PENDING)
      const invitation = await tx.venueInvitation.create({
        data: {
          venueId: venue.id,
          userId: ownerUser.id,
          invitedEmailNormalized: ownerEmail,
          role: 'OWNER',
          status: 'PENDING',
          createdByUserId: req.user!.id,
        },
      });

      // 8. Create IdentityProvisioningCommand (CREATE_ORGANIZATION)
      const command = await tx.identityProvisioningCommand.create({
        data: {
          venueId: venue.id,
          invitationId: invitation.id,
          kind: 'CREATE_ORGANIZATION',
          status: 'PENDING',
          dedupKey,
          requestHash,
          availableAt: new Date(),
        },
      });

      // 9. Audit event inside transaction
      await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user!.id,
        actorWorkosUserId: req.user!.workosUserId,
        venueId: venue.id,
        action: 'venue:draft_created',
        outcome: 'SUCCESS',
        reasonCode: 'venue_draft_created_successfully',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user!.id,
        actorWorkosUserId: req.user!.workosUserId,
        venueId: venue.id,
        action: 'invitation:queued',
        targetType: 'venue_invitation',
        targetId: invitation.id,
        outcome: 'SUCCESS',
        reasonCode: 'owner_invitation_created',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user!.id,
        actorWorkosUserId: req.user!.workosUserId,
        venueId: venue.id,
        action: 'provisioning:queued',
        targetType: 'identity_provisioning_command',
        targetId: command.id,
        outcome: 'SUCCESS',
        reasonCode: 'organization_create_queued',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });

        return { venue, domain, onboarding, ownerUser, invitation, command };
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'owner_identity_conflict') {
        return reply.status(409).send({
          error: 'Identità OWNER in conflitto',
          reasonCode: 'owner_identity_conflict',
        });
      }
      if (isUniqueViolation(err)) {
        const racedCommand = await prisma.identityProvisioningCommand.findUnique({
          where: { dedupKey },
          include: { venue: { include: { domains: true } } },
        });
        if (racedCommand) {
          if (racedCommand.requestHash !== requestHash) {
            return reply.status(409).send({
              error: 'Stessa Idempotency-Key utilizzata con payload differente',
              reasonCode: 'idempotency_key_payload_mismatch',
            });
          }
          const primaryDomain = racedCommand.venue.domains.find((domain) => domain.isPrimary);
          return reply.status(200).send({
            venueId: racedCommand.venue.id,
            name: racedCommand.venue.name,
            slug,
            hostname: primaryDomain?.hostname || hostname,
            ownerEmail,
            onboardingStatus: 'DRAFT',
            provisioningCommandId: racedCommand.id,
            idempotentReplay: true,
          });
        }
        return reply.status(409).send({
          error: 'Hostname platform già in uso',
          reasonCode: 'hostname_already_exists',
        });
      }
      throw err;
    }

    // Execute provisioning command outside of transaction
    const execRes = await executeIdentityProvisioningCommand(
      prisma,
      identityProvider,
      result.command.id,
      {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user!.id,
      }
    );
    if (execRes.success) {
      await reconcileIdentityProvisioning(
        prisma,
        identityProvider,
        result.venue.id,
        {
          requestId: req.id || `req_${Date.now()}`,
          actorUserId: req.user!.id,
        }
      );
    }

    return reply.status(201).send({
      venueId: result.venue.id,
      name: result.venue.name,
      slug,
      hostname: result.domain.hostname,
      ownerEmail,
      onboardingStatus: result.onboarding.status,
      provisioningCommandId: result.command.id,
      provisioningResult: execRes,
    });
  });

  // GET /api/platform/venues/:venueId/onboarding
  fastify.get('/api/platform/venues/:venueId/onboarding', {
    preHandler: [sessionGuard, manageVenuesGuard],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;
    const { venueId } = req.params as { venueId: string };

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      include: {
        onboarding: true,
        onboardingSteps: true,
        domains: true,
        products: true,
        memberships: { include: { user: true } },
        invitations: true,
        provisioningCommands: { orderBy: { createdAt: 'desc' }, take: 10 },
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
    const stripeReady = venue.onboardingSteps.some(
      (step) => step.step === 'STRIPE' && step.status === 'READY' && step.source === 'PROVIDER'
    );
    const fiscalReady = venue.onboardingSteps.some(
      (step) => step.step === 'FISCAL' && step.status === 'READY' && step.source === 'PROVIDER'
    );
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

    const calculatedSteps = evaluateAllSteps(facts);
    const readiness = evaluateVenueReadiness(facts);

    return {
      venue: {
        id: venue.id,
        name: venue.name,
        isActive: venue.isActive,
        workosOrganizationId: venue.workosOrganizationId,
        vatNumber: venue.vatNumber,
        fiscalAddress: venue.fiscalAddress,
        fiscalCity: venue.fiscalCity,
        fiscalZip: venue.fiscalZip,
      },
      onboardingStatus: venue.onboarding?.status || 'DRAFT',
      steps: calculatedSteps,
      storedSteps: venue.onboardingSteps.map((step) => ({
        step: step.step,
        status: step.status,
        source: step.source,
        reasonCode: step.reasonCode,
        completedAt: step.completedAt,
      })),
      domains: venue.domains.map((domain) => ({
        hostname: domain.hostname,
        type: domain.type,
        status: domain.status,
        isPrimary: domain.isPrimary,
        verifiedAt: domain.verifiedAt,
      })),
      invitations: venue.invitations.map((i) => ({
        id: i.id,
        email: i.invitedEmailNormalized,
        role: i.role,
        status: i.status,
        workosInvitationId: i.workosInvitationId,
        sentAt: i.sentAt,
      })),
      provisioningCommands: venue.provisioningCommands.map((c) => ({
        id: c.id,
        kind: c.kind,
        status: c.status,
        attempts: c.attempts,
        lastReasonCode: c.lastReasonCode,
        availableAt: c.availableAt,
        leaseUntil: c.leaseUntil,
        completedAt: c.completedAt,
      })),
      readiness,
    };
  });

  // PATCH /api/platform/venues/:venueId/onboarding/review
  fastify.patch('/api/platform/venues/:venueId/onboarding/review', {
    ...mutationRateLimit,
    preHandler: [sessionGuard, reviewOnboardingGuard],
    schema: {
      body: {
        type: 'object',
        required: ['step', 'status'],
        additionalProperties: false,
        properties: {
          step: { type: 'string', enum: ['LEGAL', 'OPERATIONS'] },
          status: { type: 'string', enum: ['READY', 'BLOCKED'] },
          reasonCode: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9_]+$' },
        },
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;
    if (!verifyCsrfToken(req, config)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user?.id,
        actorWorkosUserId: req.user?.workosUserId,
        action: 'onboarding:reviewed',
        outcome: 'DENIED',
        reasonCode: 'csrf_validation_failed',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'CSRF token non valido', reasonCode: 'csrf_invalid' });
    }

    const idempotencyKey = validateIdempotencyKey(req, reply);
    if (!idempotencyKey) return;

    const { venueId } = req.params as { venueId: string };
    const { step, status, reasonCode } = req.body as {
      step: 'LEGAL' | 'OPERATIONS';
      status: 'READY' | 'BLOCKED';
      reasonCode?: string;
    };

    const dedupKey = computeDedupKey(req, idempotencyKey);
    const requestHash = computeRequestHash({
      venueId,
      step,
      status,
      reasonCode,
    });
    if (await sendReceiptReplay(reply, dedupKey, requestHash)) return;

    const responseBody = {
      status: 'ok',
      venueId,
      step,
      reviewStatus: status,
    };
    const reviewAuditReasonCode: AuthAuditReasonCode =
      step === 'LEGAL'
        ? status === 'READY'
          ? 'review_legal_ready'
          : 'review_legal_blocked'
        : status === 'READY'
          ? 'review_operations_ready'
          : 'review_operations_blocked';
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const venue = await tx.venue.findUnique({ where: { id: venueId } });
        if (!venue) return 'not_found' as const;

        await tx.venueOnboardingStep.upsert({
          where: { venueId_step: { venueId, step } },
          create: {
            venueId,
            step,
            status,
            source: 'PLATFORM_REVIEW',
            reasonCode:
              status === 'BLOCKED'
                ? reasonCode || 'platform_review_blocked'
                : null,
            completedAt: status === 'READY' ? new Date() : null,
          },
          update: {
            status,
            source: 'PLATFORM_REVIEW',
            reasonCode:
              status === 'BLOCKED'
                ? reasonCode || 'platform_review_blocked'
                : null,
            completedAt: status === 'READY' ? new Date() : null,
          },
        });
        await tx.venueOnboarding.update({
          where: { venueId },
          data: {
            reviewedAt: new Date(),
            reviewedByUserId: req.user!.id,
          },
        });
        await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
          requestId: req.id || `req_${Date.now()}`,
          actorUserId: req.user!.id,
          actorWorkosUserId: req.user!.workosUserId,
          venueId,
          action: 'onboarding:reviewed',
          outcome: 'SUCCESS',
          reasonCode: reviewAuditReasonCode,
          channel: 'USER',
          originInfo: getAuditOriginInfo(req),
        });
        await updateOnboardingStateTx(tx, venueId, {
          requestId: req.id,
          actorUserId: req.user!.id,
        });
        await tx.platformMutationReceipt.create({
          data: {
            actorUserId: req.user!.id,
            route: getRoutePath(req),
            dedupKey,
            requestHash,
            responseStatus: 200,
            responseBody,
          },
        });
        return 'ok' as const;
      });
      if (outcome === 'not_found') {
        return reply.status(404).send({
          error: 'Venue non trovata',
          reasonCode: 'venue_not_found',
        });
      }
    } catch (err) {
      if (isUniqueViolation(err) && await sendReceiptReplay(reply, dedupKey, requestHash)) {
        return;
      }
      throw err;
    }
    return reply.status(200).send(responseBody);
  });

  // POST /api/platform/venues/:venueId/activate
  fastify.post('/api/platform/venues/:venueId/activate', {
    ...mutationRateLimit,
    preHandler: [sessionGuard, manageVenuesGuard],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;
    if (!verifyCsrfToken(req, config)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user?.id,
        actorWorkosUserId: req.user?.workosUserId,
        action: 'venue:activation_denied',
        outcome: 'DENIED',
        reasonCode: 'csrf_validation_failed',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'CSRF token non valido', reasonCode: 'csrf_invalid' });
    }

    const idempotencyKey = validateIdempotencyKey(req, reply);
    if (!idempotencyKey) return;

    const { venueId } = req.params as { venueId: string };
    const dedupKey = computeDedupKey(req, idempotencyKey);
    const requestHash = computeRequestHash({ venueId });

    if (await sendReceiptReplay(reply, dedupKey, requestHash)) return;

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
      // R4: SELECT FOR UPDATE on venue row
      const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM venues WHERE id = ${venueId} FOR UPDATE
      `;

      if (lockedRows.length === 0) {
        const responseBody = {
          error: 'Venue non trovata',
          reasonCode: 'venue_not_found',
        };
        await tx.platformMutationReceipt.create({
          data: {
            actorUserId: req.user!.id,
            route: getRoutePath(req),
            dedupKey,
            requestHash,
            responseStatus: 404,
            responseBody,
          },
        });
        return { type: 'not_found' as const, responseBody };
      }

      const venue = await tx.venue.findUnique({
        where: { id: venueId },
        include: {
          onboarding: true,
          onboardingSteps: true,
          domains: true,
          products: true,
          memberships: { include: { user: true } },
        },
      });

      if (!venue) throw new Error('locked_venue_not_found');

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
      const stripeReady = venue.onboardingSteps.some(
        (step) => step.step === 'STRIPE' && step.status === 'READY' && step.source === 'PROVIDER'
      );
      const fiscalReady = venue.onboardingSteps.some(
        (step) => step.step === 'FISCAL' && step.status === 'READY' && step.source === 'PROVIDER'
      );
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

      if (!readiness.eligible) {
        await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
          requestId: req.id || `req_${Date.now()}`,
          actorUserId: req.user!.id,
          actorWorkosUserId: req.user!.workosUserId,
          venueId: venue.id,
          action: 'venue:activation_denied',
          outcome: 'DENIED',
          reasonCode: 'activation_readiness_failed',
          channel: 'USER',
          originInfo: getAuditOriginInfo(req),
        });

        const responseBody = {
          error: 'Venue non eleggibile per attivazione',
          reasonCode: 'activation_denied',
          eligible: false,
          missingSteps: readiness.missingSteps,
          reasonCodes: readiness.reasonCodes,
        };
        await tx.platformMutationReceipt.create({
          data: {
            actorUserId: req.user!.id,
            route: getRoutePath(req),
            dedupKey,
            requestHash,
            responseStatus: 400,
            responseBody,
          },
        });
        return { type: 'denied' as const, responseBody };
      }

      await tx.venue.update({
        where: { id: venueId },
        data: { isActive: true },
      });

      await tx.venueOnboarding.update({
        where: { venueId },
        data: {
          status: 'ACTIVE',
          activatedAt: new Date(),
        },
      });

      const responseBody = { status: 'ok', venueId, isActive: true };
      await tx.platformMutationReceipt.create({
        data: {
          actorUserId: req.user!.id,
          route: getRoutePath(req),
          dedupKey,
          requestHash,
          responseStatus: 200,
          responseBody,
        },
      });

      await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user!.id,
        actorWorkosUserId: req.user!.workosUserId,
        venueId: venue.id,
        action: 'venue:activated',
        outcome: 'SUCCESS',
        reasonCode: 'venue_activated_successfully',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });

        return { type: 'success' as const, responseBody };
      });
    } catch (err) {
      if (isUniqueViolation(err) && await sendReceiptReplay(reply, dedupKey, requestHash)) {
        return;
      }
      throw err;
    }

    if (result.type === 'not_found') {
      return reply.status(404).send(result.responseBody);
    }

    if (result.type === 'denied') {
      return reply.status(400).send(result.responseBody);
    }

    return reply.status(200).send(result.responseBody);
  });

  // POST /api/platform/invitations/:invitationId/resend
  fastify.post('/api/platform/invitations/:invitationId/resend', {
    ...mutationRateLimit,
    preHandler: [sessionGuard, manageInvitationsGuard],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;
    if (!verifyCsrfToken(req, config)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user?.id,
        actorWorkosUserId: req.user?.workosUserId,
        action: 'invitation:resent',
        outcome: 'DENIED',
        reasonCode: 'csrf_validation_failed',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'CSRF token non valido', reasonCode: 'csrf_invalid' });
    }

    const idempotencyKey = validateIdempotencyKey(req, reply);
    if (!idempotencyKey) return;

    const { invitationId } = req.params as { invitationId: string };
    const invitation = await prisma.venueInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      return reply.status(404).send({ error: 'Invito non trovato', reasonCode: 'invitation_not_found' });
    }

    const dedupKey = computeDedupKey(req, idempotencyKey);
    const requestHash = computeRequestHash({ invitationId });

    const existingCmd = await prisma.identityProvisioningCommand.findUnique({
      where: { dedupKey },
    });

    if (existingCmd) {
      if (existingCmd.requestHash !== requestHash) {
        return reply.status(409).send({
          error: 'Stessa Idempotency-Key utilizzata con payload differente',
          reasonCode: 'idempotency_key_payload_mismatch',
        });
      }
      return sendCommandResult(reply, existingCmd, invitationId, true);
    }

    if (!['PENDING', 'SENT'].includes(invitation.status) || !invitation.workosInvitationId) {
      return reply.status(409).send({
        error: 'Invito non reinviabile',
        reasonCode: 'invitation_not_resendable',
      });
    }

    let command;
    try {
      command = await prisma.$transaction(async (tx) => {
        const created = await tx.identityProvisioningCommand.create({
          data: {
            venueId: invitation.venueId,
            invitationId: invitation.id,
            kind: 'RESEND_INVITATION',
            status: 'PENDING',
            dedupKey,
            requestHash,
          },
        });
        await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
          requestId: req.id,
          actorUserId: req.user!.id,
          actorWorkosUserId: req.user!.workosUserId,
          venueId: invitation.venueId,
          action: 'provisioning:queued',
          outcome: 'SUCCESS',
          reasonCode: 'invitation_resend_queued',
          channel: 'USER',
          originInfo: getAuditOriginInfo(req),
        });
        return created;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await prisma.identityProvisioningCommand.findUnique({ where: { dedupKey } });
      if (!raced) throw err;
      if (raced.requestHash !== requestHash) {
        return reply.status(409).send({
          error: 'Stessa Idempotency-Key utilizzata con payload differente',
          reasonCode: 'idempotency_key_payload_mismatch',
        });
      }
      return sendCommandResult(reply, raced, invitationId, true);
    }
    await executeIdentityProvisioningCommand(prisma, identityProvider, command.id, {
      requestId: req.id || `req_${Date.now()}`,
      actorUserId: req.user!.id,
    });

    const completedCommand = await prisma.identityProvisioningCommand.findUniqueOrThrow({
      where: { id: command.id },
    });
    return sendCommandResult(reply, completedCommand, invitationId);
  });

  // POST /api/platform/invitations/:invitationId/revoke
  fastify.post('/api/platform/invitations/:invitationId/revoke', {
    ...mutationRateLimit,
    preHandler: [sessionGuard, manageInvitationsGuard],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;
    if (!verifyCsrfToken(req, config)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user?.id,
        actorWorkosUserId: req.user?.workosUserId,
        action: 'invitation:revoked',
        outcome: 'DENIED',
        reasonCode: 'csrf_validation_failed',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'CSRF token non valido', reasonCode: 'csrf_invalid' });
    }

    const idempotencyKey = validateIdempotencyKey(req, reply);
    if (!idempotencyKey) return;

    const { invitationId } = req.params as { invitationId: string };
    const invitation = await prisma.venueInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      return reply.status(404).send({ error: 'Invito non trovato', reasonCode: 'invitation_not_found' });
    }

    const dedupKey = computeDedupKey(req, idempotencyKey);
    const requestHash = computeRequestHash({ invitationId });

    const existingCmd = await prisma.identityProvisioningCommand.findUnique({
      where: { dedupKey },
    });

    if (existingCmd) {
      if (existingCmd.requestHash !== requestHash) {
        return reply.status(409).send({
          error: 'Stessa Idempotency-Key utilizzata con payload differente',
          reasonCode: 'idempotency_key_payload_mismatch',
        });
      }
      return sendCommandResult(reply, existingCmd, invitationId, true);
    }

    if (!['PENDING', 'SENT'].includes(invitation.status)) {
      return reply.status(409).send({
        error: 'Invito non revocabile',
        reasonCode: 'invitation_not_revocable',
      });
    }

    let command;
    try {
      command = await prisma.$transaction(async (tx) => {
        const created = await tx.identityProvisioningCommand.create({
          data: {
            venueId: invitation.venueId,
            invitationId: invitation.id,
            kind: 'REVOKE_INVITATION',
            status: 'PENDING',
            dedupKey,
            requestHash,
          },
        });
        await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
          requestId: req.id,
          actorUserId: req.user!.id,
          actorWorkosUserId: req.user!.workosUserId,
          venueId: invitation.venueId,
          action: 'provisioning:queued',
          outcome: 'SUCCESS',
          reasonCode: 'invitation_revoke_queued',
          channel: 'USER',
          originInfo: getAuditOriginInfo(req),
        });
        return created;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await prisma.identityProvisioningCommand.findUnique({ where: { dedupKey } });
      if (!raced) throw err;
      if (raced.requestHash !== requestHash) {
        return reply.status(409).send({
          error: 'Stessa Idempotency-Key utilizzata con payload differente',
          reasonCode: 'idempotency_key_payload_mismatch',
        });
      }
      return sendCommandResult(reply, raced, invitationId, true);
    }
    await executeIdentityProvisioningCommand(prisma, identityProvider, command.id, {
      requestId: req.id || `req_${Date.now()}`,
      actorUserId: req.user!.id,
    });
    const completedCommand = await prisma.identityProvisioningCommand.findUniqueOrThrow({
      where: { id: command.id },
    });
    return sendCommandResult(reply, completedCommand, invitationId);
  });

  // POST /api/platform/provisioning/:commandId/retry
  fastify.post('/api/platform/provisioning/:commandId/retry', {
    ...mutationRateLimit,
    preHandler: [sessionGuard, manageVenuesGuard],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireConsoleHost(req, reply)) return;
    if (!verifyCsrfToken(req, config)) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        actorUserId: req.user?.id,
        actorWorkosUserId: req.user?.workosUserId,
        action: 'provisioning:retryable',
        outcome: 'DENIED',
        reasonCode: 'csrf_validation_failed',
        channel: 'USER',
        originInfo: getAuditOriginInfo(req),
      });
      return reply.status(403).send({ error: 'CSRF token non valido', reasonCode: 'csrf_invalid' });
    }

    const idempotencyKey = validateIdempotencyKey(req, reply);
    if (!idempotencyKey) return;

    const { commandId } = req.params as { commandId: string };
    const dedupKey = computeDedupKey(req, idempotencyKey);
    const requestHash = computeRequestHash({ commandId });

    if (await sendReceiptReplay(reply, dedupKey, requestHash)) return;

    const command = await prisma.identityProvisioningCommand.findUnique({
      where: { id: commandId },
    });

    if (!command) {
      return reply.status(404).send({ error: 'Comando non trovato', reasonCode: 'command_not_found' });
    }
    if (command.kind === 'RESEND_INVITATION') {
      return reply.status(409).send({
        error: 'Un resend ambiguo richiede una nuova azione esplicita',
        reasonCode: 'resend_retry_forbidden',
      });
    }
    if (command.status !== 'RETRYABLE') {
      return reply.status(409).send({
        error: 'Comando non riprovabile nello stato corrente',
        reasonCode: 'command_not_retryable',
      });
    }

    const responseBody = { status: 'queued', commandId };
    try {
      await prisma.$transaction(async (tx) => {
        await tx.identityProvisioningCommand.update({
          where: { id: commandId },
          data: {
            status: 'PENDING',
            availableAt: new Date(),
            leaseUntil: null,
          },
        });
        await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
          requestId: req.id,
          actorUserId: req.user!.id,
          actorWorkosUserId: req.user!.workosUserId,
          venueId: command.venueId,
          action: 'provisioning:queued',
          outcome: 'SUCCESS',
          reasonCode: 'manual_retry_queued',
          channel: 'USER',
          originInfo: getAuditOriginInfo(req),
        });
        await tx.platformMutationReceipt.create({
          data: {
            actorUserId: req.user!.id,
            route: getRoutePath(req),
            dedupKey,
            requestHash,
            responseStatus: 202,
            responseBody,
          },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err) && await sendReceiptReplay(reply, dedupKey, requestHash)) {
        return;
      }
      throw err;
    }

    await executeIdentityProvisioningCommand(prisma, identityProvider, commandId, {
      requestId: req.id || `req_${Date.now()}`,
      actorUserId: req.user!.id,
    });
    return reply.status(202).send(responseBody);
  });
}
