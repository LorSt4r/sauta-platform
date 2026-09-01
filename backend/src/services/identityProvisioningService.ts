import {
  IdentityProvisioningStatus,
  Prisma,
  PrismaClient,
  VenueOnboardingStepName,
} from '@prisma/client';
import { IdentityProvider } from '../utils/identityProvider';
import { evaluateAllSteps } from './onboardingStateMachine';
import type { AuthAuditReasonCode } from '../utils/auditLogger';

export const LEASE_DURATION_MS = 5 * 60 * 1000;
export const MAX_COMMAND_ATTEMPTS = 5;
export const RETRY_BACKOFF_BASE_MS = 30_000;
export const RETRY_BACKOFF_MAX_MS = 15 * 60 * 1000;

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface ExecuteCommandOptions {
  requestId?: string;
  actorUserId?: string;
}

class ProvisioningError extends Error {
  constructor(
    readonly reasonCode: AuthAuditReasonCode,
    readonly terminal = false
  ) {
    super(reasonCode);
  }
}

export function computeRetryBackoffMs(attempts: number): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  return Math.min(
    RETRY_BACKOFF_BASE_MS * (2 ** (safeAttempts - 1)),
    RETRY_BACKOFF_MAX_MS
  );
}

function safeProviderReason(err: unknown): AuthAuditReasonCode {
  if (err instanceof ProvisioningError) return err.reasonCode;
  return 'workos_provider_unavailable';
}

function providerStepIsReady(
  step: { status: string; source: string } | undefined
): boolean {
  return step?.status === 'READY' && step.source === 'PROVIDER';
}

/**
 * Recalculates the seven checklist steps and the aggregate in one DB
 * transaction. Provider readiness is accepted only from durable PROVIDER
 * snapshots; legacy Stripe/A-Cube columns never certify a new venue.
 */
export async function updateOnboardingStateTx(
  tx: TransactionClient,
  venueId: string,
  opts: ExecuteCommandOptions = {}
): Promise<void> {
  const venue = await tx.venue.findUnique({
    where: { id: venueId },
    include: {
      domains: true,
      products: true,
      memberships: { include: { user: true } },
      onboarding: true,
    },
  });
  if (!venue) return;

  const existingSteps = await tx.venueOnboardingStep.findMany({ where: { venueId } });
  const stepMap = new Map(existingSteps.map((step) => [step.step, step]));
  const hasActiveOwner = venue.memberships.some(
    (membership) =>
      membership.role === 'OWNER' &&
      membership.status === 'ACTIVE' &&
      membership.user.status === 'ACTIVE'
  );
  const hasVerifiedPlatformDomain = venue.domains.some(
    (domain) =>
      domain.type === 'PLATFORM' &&
      domain.status === 'VERIFIED' &&
      domain.isPrimary
  );
  const hasValidCatalog = venue.products.some(
    (product) => product.active && product.price > 0 && product.vatRate >= 0
  );
  const legalInfoComplete = Boolean(
    venue.vatNumber &&
    venue.fiscalAddress &&
    venue.fiscalCity &&
    venue.fiscalZip
  );
  const legalStep = stepMap.get('LEGAL');
  const operationsStep = stepMap.get('OPERATIONS');
  const facts = {
    venueId,
    onboardingStatus: venue.onboarding?.status || 'DRAFT',
    isActive: venue.isActive,
    hasActiveOwner,
    hasVerifiedPlatformDomain,
    hasValidCatalog,
    legalInfoComplete,
    legalReviewed:
      legalStep?.source === 'PLATFORM_REVIEW' && legalStep.status === 'READY',
    operationsReviewed:
      operationsStep?.source === 'PLATFORM_REVIEW' &&
      operationsStep.status === 'READY',
    stripeReady: providerStepIsReady(stepMap.get('STRIPE')),
    fiscalReady: providerStepIsReady(stepMap.get('FISCAL')),
    workosOrganizationMapped: Boolean(venue.workosOrganizationId),
  } as const;

  const computedSteps = evaluateAllSteps(facts);
  const finalStatuses = new Map<VenueOnboardingStepName, string>();

  for (const stepName of Object.keys(computedSteps) as VenueOnboardingStepName[]) {
    const existing = stepMap.get(stepName);
    if (
      existing?.source === 'LEGACY_BACKFILL' &&
      venue.isActive &&
      venue.onboarding?.status === 'ACTIVE'
    ) {
      finalStatuses.set(stepName, existing.status);
      continue;
    }
    const evaluated = computedSteps[stepName];
    finalStatuses.set(stepName, evaluated.status);
    await tx.venueOnboardingStep.upsert({
      where: { venueId_step: { venueId, step: stepName } },
      create: {
        venueId,
        step: stepName,
        status: evaluated.status,
        source: evaluated.source,
        reasonCode: evaluated.reasonCode,
        completedAt: evaluated.status === 'READY' ? new Date() : null,
      },
      update: {
        status: evaluated.status,
        source: evaluated.source,
        reasonCode: evaluated.reasonCode,
        completedAt: evaluated.status === 'READY' ? new Date() : null,
      },
    });
  }

  const currentStatus = venue.onboarding?.status || 'DRAFT';
  const allStepsReady =
    finalStatuses.size === 7 &&
    Array.from(finalStatuses.values()).every((status) => status === 'READY');
  let nextStatus = currentStatus;

  if (
    currentStatus === 'DRAFT' &&
    (facts.workosOrganizationMapped ||
      Array.from(finalStatuses.values()).some((status) => status !== 'NOT_STARTED'))
  ) {
    nextStatus = 'IN_PROGRESS';
  } else if (
    currentStatus === 'IN_PROGRESS' &&
    allStepsReady &&
    facts.workosOrganizationMapped
  ) {
    nextStatus = 'READY_FOR_REVIEW';
  } else if (
    currentStatus === 'READY_FOR_REVIEW' &&
    (!allStepsReady || !facts.workosOrganizationMapped)
  ) {
    nextStatus = 'IN_PROGRESS';
  }

  await tx.venueOnboarding.upsert({
    where: { venueId },
    create: { venueId, status: nextStatus },
    update: {
      status: nextStatus,
      ...(nextStatus === 'READY_FOR_REVIEW' && currentStatus !== nextStatus
        ? { submittedAt: new Date() }
        : {}),
    },
  });

  if (currentStatus !== nextStatus) {
    let transitionReasonCode: AuthAuditReasonCode;
    if (currentStatus === 'DRAFT' && nextStatus === 'IN_PROGRESS') {
      transitionReasonCode = 'onboarding_draft_to_in_progress';
    } else if (
      currentStatus === 'IN_PROGRESS' &&
      nextStatus === 'READY_FOR_REVIEW'
    ) {
      transitionReasonCode = 'onboarding_in_progress_to_ready_for_review';
    } else {
      transitionReasonCode = 'onboarding_ready_for_review_to_in_progress';
    }
    await tx.authAuditEvent.create({
      data: {
        requestId: opts.requestId || `req_onboarding_${venueId}`,
        actorUserId: opts.actorUserId || null,
        venueId,
        action: 'onboarding:step_updated',
        outcome: 'SUCCESS',
        reasonCode: transitionReasonCode,
        channel: 'SYSTEM',
      },
    });
  }
}

/**
 * Atomically claims one durable command and writes the claim audit in the
 * same short transaction. No provider call is made here.
 */
export async function claimCommand(
  prisma: PrismaClient,
  commandId: string,
  opts: ExecuteCommandOptions = {}
): Promise<boolean> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_DURATION_MS);

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<Array<{ venueId: string }>>(Prisma.sql`
      UPDATE "identity_provisioning_commands"
      SET "status" = 'PROCESSING'::"IdentityProvisioningStatus",
          "lease_until" = ${leaseUntil},
          "attempts" = "attempts" + 1,
          "updated_at" = NOW()
      WHERE "id" = ${commandId}
        AND (
          "status" IN (
            'PENDING'::"IdentityProvisioningStatus",
            'RETRYABLE'::"IdentityProvisioningStatus"
          )
          OR (
            "status" = 'PROCESSING'::"IdentityProvisioningStatus"
            AND "lease_until" <= ${now}
          )
        )
        AND ("lease_until" IS NULL OR "lease_until" <= ${now})
        AND "available_at" <= ${now}
        AND "attempts" < ${MAX_COMMAND_ATTEMPTS}
      RETURNING "venue_id" AS "venueId"
    `);
    const claimedCommand = claimed[0];
    if (!claimedCommand) return false;

    await tx.authAuditEvent.create({
      data: {
        requestId: opts.requestId || `req_claim_${commandId}`,
        actorUserId: opts.actorUserId || null,
        venueId: claimedCommand.venueId,
        action: 'provisioning:claimed',
        outcome: 'SUCCESS',
        reasonCode: 'provisioning_command_claimed',
        channel: 'SYSTEM',
      },
    });
    return true;
  });
}

async function persistFailure(
  prisma: PrismaClient,
  command: {
    id: string;
    venueId: string;
    attempts: number;
  },
  reasonCode: AuthAuditReasonCode,
  terminal: boolean,
  opts: ExecuteCommandOptions
): Promise<IdentityProvisioningStatus> {
  const status: IdentityProvisioningStatus =
    terminal || command.attempts >= MAX_COMMAND_ATTEMPTS ? 'FAILED' : 'RETRYABLE';
  const availableAt =
    status === 'RETRYABLE'
      ? new Date(Date.now() + computeRetryBackoffMs(command.attempts))
      : new Date();

  await prisma.$transaction(async (tx) => {
    await tx.identityProvisioningCommand.update({
      where: { id: command.id },
      data: {
        status,
        leaseUntil: null,
        availableAt,
        lastReasonCode: reasonCode,
      },
    });
    await tx.authAuditEvent.create({
      data: {
        requestId: opts.requestId || `req_prov_${command.id}`,
        actorUserId: opts.actorUserId || null,
        venueId: command.venueId,
        action: status === 'FAILED' ? 'provisioning:failed' : 'provisioning:retryable',
        outcome: 'ERROR',
        reasonCode,
        channel: 'SYSTEM',
      },
    });
  });
  return status;
}

export async function executeIdentityProvisioningCommand(
  prisma: PrismaClient,
  identityProvider: IdentityProvider,
  commandId: string,
  opts: ExecuteCommandOptions = {}
): Promise<{
  success: boolean;
  status: IdentityProvisioningStatus;
  reasonCode: string | null;
}> {
  const claimed = await claimCommand(prisma, commandId, opts);
  if (!claimed) {
    let command = await prisma.identityProvisioningCommand.findUnique({
      where: { id: commandId },
    });
    const leaseExpired =
      command?.status !== 'PROCESSING' ||
      !command.leaseUntil ||
      command.leaseUntil.getTime() <= Date.now();
    if (
      command &&
      command.attempts >= MAX_COMMAND_ATTEMPTS &&
      leaseExpired &&
      (command.status === 'PENDING' ||
        command.status === 'RETRYABLE' ||
        command.status === 'PROCESSING')
    ) {
      await prisma.$transaction(async (tx) => {
        const exhausted = await tx.identityProvisioningCommand.updateMany({
          where: {
            id: commandId,
            attempts: { gte: MAX_COMMAND_ATTEMPTS },
            OR: [
              { status: { in: ['PENDING', 'RETRYABLE'] } },
              {
                status: 'PROCESSING',
                leaseUntil: { lte: new Date() },
              },
            ],
          },
          data: {
            status: 'FAILED',
            leaseUntil: null,
            lastReasonCode: 'maximum_attempts_exhausted',
          },
        });
        if (exhausted.count === 1) {
          await tx.authAuditEvent.create({
            data: {
              requestId: opts.requestId || `req_prov_${commandId}`,
              actorUserId: opts.actorUserId || null,
              venueId: command!.venueId,
              action: 'provisioning:failed',
              outcome: 'ERROR',
              reasonCode: 'maximum_attempts_exhausted',
              channel: 'SYSTEM',
            },
          });
        }
      });
      command = await prisma.identityProvisioningCommand.findUnique({
        where: { id: commandId },
      });
    }
    return {
      success: command?.status === 'SUCCEEDED',
      status: command?.status || 'FAILED',
      reasonCode:
        command?.lastReasonCode || 'claim_failed_concurrency_or_max_attempts',
    };
  }

  const command = await prisma.identityProvisioningCommand.findUnique({
    where: { id: commandId },
    include: { venue: true, invitation: true },
  });
  if (!command) {
    return { success: false, status: 'FAILED', reasonCode: 'command_not_found' };
  }

  const requestId = opts.requestId || `req_prov_${command.id}`;
  const actorUserId = opts.actorUserId || null;

  try {
    if (command.kind === 'CREATE_ORGANIZATION') {
      const externalId = `sauta-venue:${command.venueId}`;
      let organization = await identityProvider.findOrganizationByExternalId(externalId);

      if (!organization) {
        try {
          organization = await identityProvider.createOrganization({
            name: command.venue.name,
            externalId,
            idempotencyKey: command.id,
          });
        } catch {
          organization = await identityProvider.findOrganizationByExternalId(externalId);
          if (!organization) {
            throw new ProvisioningError('organization_create_ambiguous');
          }
        }
      }

      if (organization.externalId !== externalId) {
        throw new ProvisioningError('organization_external_id_mismatch', true);
      }
      if (
        command.venue.workosOrganizationId &&
        command.venue.workosOrganizationId !== organization.id
      ) {
        throw new ProvisioningError('organization_mapping_conflict', true);
      }
      const conflictingVenue = await prisma.venue.findFirst({
        where: {
          workosOrganizationId: organization.id,
          id: { not: command.venueId },
        },
        select: { id: true },
      });
      if (conflictingVenue) {
        throw new ProvisioningError('organization_mapping_conflict', true);
      }

      await prisma.$transaction(async (tx) => {
        await tx.venue.update({
          where: { id: command.venueId },
          data: { workosOrganizationId: organization!.id },
        });
        await tx.identityProvisioningCommand.update({
          where: { id: command.id },
          data: {
            status: 'SUCCEEDED',
            leaseUntil: null,
            completedAt: new Date(),
            lastReasonCode: null,
          },
        });

        if (command.invitationId) {
          const sendDedupKey = `send_invitation:${command.invitationId}`;
          const sendCommand = await tx.identityProvisioningCommand.upsert({
            where: { dedupKey: sendDedupKey },
            create: {
              venueId: command.venueId,
              invitationId: command.invitationId,
              kind: 'SEND_INVITATION',
              status: 'PENDING',
              dedupKey: sendDedupKey,
              requestHash: command.requestHash,
              availableAt: new Date(),
            },
            update: {},
          });
          await tx.authAuditEvent.create({
            data: {
              requestId,
              actorUserId,
              venueId: command.venueId,
              action: 'invitation:queued',
              targetType: 'identity_provisioning_command',
              targetId: sendCommand.id,
              outcome: 'SUCCESS',
              reasonCode: 'invitation_send_queued',
              channel: 'SYSTEM',
            },
          });
        }

        await tx.authAuditEvent.create({
          data: {
            requestId,
            actorUserId,
            venueId: command.venueId,
            workosOrganizationId: organization!.id,
            action: 'organization:mapped',
            outcome: 'SUCCESS',
            reasonCode: 'organization_mapped_successfully',
            channel: 'SYSTEM',
          },
        });
        await updateOnboardingStateTx(tx, command.venueId, opts);
      });
      return { success: true, status: 'SUCCEEDED', reasonCode: null };
    }

    if (command.kind === 'SEND_INVITATION') {
      if (!command.invitation) {
        throw new ProvisioningError('invitation_record_missing', true);
      }
      if (!command.venue.workosOrganizationId) {
        throw new ProvisioningError('organization_not_mapped_yet');
      }

      const organizationId = command.venue.workosOrganizationId;
      const email = command.invitation.invitedEmailNormalized;
      let candidates =
        await identityProvider.listInvitationsByOrganizationAndEmail({
          organizationId,
          email,
        });
      if (
        candidates.some(
          (candidate) =>
            candidate.organizationId !== organizationId ||
            candidate.email !== email
        )
      ) {
        throw new ProvisioningError('invitation_provider_mismatch', true);
      }

      let recoverable = candidates.filter(
        (candidate) => candidate.status === 'pending'
      );
      if (recoverable.length > 1) {
        throw new ProvisioningError(
          'ambiguous_multiple_invitation_candidates',
          true
        );
      }

      let providerInvitation = recoverable[0] || null;
      let reconciled = Boolean(providerInvitation);
      if (!providerInvitation && candidates.length > 0) {
        throw new ProvisioningError('invitation_state_conflict', true);
      }
      if (!providerInvitation) {
        try {
          providerInvitation = await identityProvider.sendInvitation({
            organizationId,
            email,
          });
        } catch {
          candidates =
            await identityProvider.listInvitationsByOrganizationAndEmail({
              organizationId,
              email,
            });
          recoverable = candidates.filter(
            (candidate) =>
              candidate.status === 'pending' &&
              candidate.organizationId === organizationId &&
              candidate.email === email
          );
          if (recoverable.length > 1) {
            throw new ProvisioningError(
              'ambiguous_multiple_invitation_candidates',
              true
            );
          }
          if (recoverable.length !== 1) {
            throw new ProvisioningError('invitation_send_ambiguous');
          }
          providerInvitation = recoverable[0]!;
          reconciled = true;
        }
      }
      if (
        providerInvitation.organizationId !== organizationId ||
        providerInvitation.email !== email ||
        providerInvitation.status !== 'pending'
      ) {
        throw new ProvisioningError('invitation_provider_mismatch', true);
      }
      const conflictingInvitation = await prisma.venueInvitation.findFirst({
        where: {
          workosInvitationId: providerInvitation.id,
          id: { not: command.invitationId! },
        },
        select: { id: true },
      });
      if (conflictingInvitation) {
        throw new ProvisioningError('invitation_mapping_conflict', true);
      }

      await prisma.$transaction(async (tx) => {
        await tx.venueInvitation.update({
          where: { id: command.invitationId! },
          data: {
            workosInvitationId: providerInvitation!.id,
            status: 'SENT',
            sentAt: new Date(),
            expiresAt: providerInvitation!.expiresAt
              ? new Date(providerInvitation!.expiresAt)
              : null,
          },
        });
        await tx.identityProvisioningCommand.update({
          where: { id: command.id },
          data: {
            status: 'SUCCEEDED',
            leaseUntil: null,
            completedAt: new Date(),
            lastReasonCode: null,
          },
        });
        await tx.authAuditEvent.create({
          data: {
            requestId,
            actorUserId,
            venueId: command.venueId,
            workosOrganizationId: organizationId,
            action: reconciled ? 'invitation:reconciled' : 'invitation:sent',
            outcome: 'SUCCESS',
            reasonCode: reconciled
              ? 'invitation_reconciled_successfully'
              : 'invitation_sent_successfully',
            channel: 'SYSTEM',
          },
        });
        await updateOnboardingStateTx(tx, command.venueId, opts);
      });
      return { success: true, status: 'SUCCEEDED', reasonCode: null };
    }

    if (command.kind === 'REVOKE_INVITATION') {
      if (!command.invitation) {
        throw new ProvisioningError('invitation_record_missing', true);
      }
      if (command.invitation.workosInvitationId) {
        const revoked = await identityProvider.revokeInvitation(
          command.invitation.workosInvitationId
        );
        if (
          revoked.id !== command.invitation.workosInvitationId ||
          revoked.organizationId !== command.venue.workosOrganizationId ||
          revoked.email !== command.invitation.invitedEmailNormalized ||
          revoked.status !== 'revoked'
        ) {
          throw new ProvisioningError('invitation_provider_mismatch', true);
        }
      }
      await prisma.$transaction(async (tx) => {
        await tx.venueInvitation.update({
          where: { id: command.invitationId! },
          data: { status: 'REVOKED', revokedAt: new Date() },
        });
        await tx.identityProvisioningCommand.update({
          where: { id: command.id },
          data: {
            status: 'SUCCEEDED',
            leaseUntil: null,
            completedAt: new Date(),
            lastReasonCode: null,
          },
        });
        await tx.authAuditEvent.create({
          data: {
            requestId,
            actorUserId,
            venueId: command.venueId,
            action: 'invitation:revoked',
            outcome: 'SUCCESS',
            reasonCode: 'invitation_revoked_successfully',
            channel: 'SYSTEM',
          },
        });
        await updateOnboardingStateTx(tx, command.venueId, opts);
      });
      return { success: true, status: 'SUCCEEDED', reasonCode: null };
    }

    if (command.kind === 'RESEND_INVITATION') {
      if (!command.invitation?.workosInvitationId) {
        throw new ProvisioningError(
          'workos_invitation_id_missing_for_resend',
          true
        );
      }
      let resent;
      try {
        resent = await identityProvider.resendInvitation(
          command.invitation.workosInvitationId
        );
      } catch {
        throw new ProvisioningError('workos_resend_ambiguous_failure', true);
      }
      if (
        resent.id !== command.invitation.workosInvitationId ||
        resent.organizationId !== command.venue.workosOrganizationId ||
        resent.email !== command.invitation.invitedEmailNormalized ||
        resent.status !== 'pending'
      ) {
        throw new ProvisioningError('invitation_provider_mismatch', true);
      }

      await prisma.$transaction(async (tx) => {
        await tx.venueInvitation.update({
          where: { id: command.invitationId! },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            expiresAt: resent.expiresAt ? new Date(resent.expiresAt) : null,
          },
        });
        await tx.identityProvisioningCommand.update({
          where: { id: command.id },
          data: {
            status: 'SUCCEEDED',
            leaseUntil: null,
            completedAt: new Date(),
            lastReasonCode: null,
          },
        });
        await tx.authAuditEvent.create({
          data: {
            requestId,
            actorUserId,
            venueId: command.venueId,
            action: 'invitation:resent',
            outcome: 'SUCCESS',
            reasonCode: 'invitation_resent_successfully',
            channel: 'SYSTEM',
          },
        });
        await updateOnboardingStateTx(tx, command.venueId, opts);
      });
      return { success: true, status: 'SUCCEEDED', reasonCode: null };
    }

    throw new ProvisioningError('unknown_command_kind', true);
  } catch (err) {
    const reasonCode = safeProviderReason(err);
    const terminal = err instanceof ProvisioningError && err.terminal;
    const status = await persistFailure(
      prisma,
      command,
      reasonCode,
      terminal,
      opts
    );
    return { success: false, status, reasonCode };
  }
}

export async function reconcileIdentityProvisioning(
  prisma: PrismaClient,
  identityProvider: IdentityProvider,
  venueId: string,
  opts: ExecuteCommandOptions = {}
): Promise<void> {
  const commands = await prisma.identityProvisioningCommand.findMany({
    where: {
      venueId,
      status: { in: ['PENDING', 'RETRYABLE'] },
      availableAt: { lte: new Date() },
    },
    orderBy: { createdAt: 'asc' },
  });
  for (const command of commands) {
    await executeIdentityProvisioningCommand(
      prisma,
      identityProvider,
      command.id,
      opts
    );
  }
}
