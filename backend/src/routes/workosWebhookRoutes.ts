import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient, VenueMembershipStatus } from '@prisma/client';
import type { AppConfig } from '../utils/config';
import type {
  IdentityProvider,
  WorkosWebhookEvent,
} from '../utils/identityProvider';
import {
  logAuthAuditEvent,
  type AuthAuditReasonCode,
} from '../utils/auditLogger';

type MembershipWatermark = {
  id: string;
  workosUpdatedAt: Date | null;
};

export function getWorkosObjectTimestamp(
  data: WorkosWebhookEvent['data'],
  eventCreatedAt?: string
): Date | null {
  const rawTimestamp = data.updatedAt ?? data.updated_at ?? eventCreatedAt;
  if (typeof rawTimestamp !== 'string') return null;
  const timestamp = new Date(rawTimestamp);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

export async function registerWorkosWebhookRoutes(
  fastify: FastifyInstance,
  opts: {
    prisma: PrismaClient;
    config: AppConfig;
    identityProvider: IdentityProvider;
  }
) {
  const { prisma, config, identityProvider } = opts;

  fastify.post('/api/webhooks/workos', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const sigHeader = req.headers['workos-signature'];

    if (!sigHeader || typeof sigHeader !== 'string') {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'webhook:workos',
        outcome: 'DENIED',
        reasonCode: 'missing_signature_header',
        channel: 'WEBHOOK',
      });
      return reply.status(400).send({ error: 'Firma webhook WorkOS mancante' });
    }

    const rawBody =
      (req as FastifyRequest & { rawBody?: Buffer | string }).rawBody ??
      req.body;
    let event: WorkosWebhookEvent;

    try {
      event = await identityProvider.verifyWebhookSignature({
        payload: rawBody,
        sigHeader,
      });
    } catch {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'webhook:workos',
        outcome: 'DENIED',
        reasonCode: 'invalid_webhook_signature',
        channel: 'WEBHOOK',
      });
      return reply.status(400).send({ error: 'Firma webhook WorkOS non valida' });
    }

    const eventId = event.id;
    const eventType = event.event;
    // Controllo di idempotenza
    const existing = await prisma.processedWorkosEvent.findUnique({
      where: { eventId },
    });

    if (existing) {
      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'webhook:workos',
        outcome: 'SUCCESS',
        reasonCode: 'duplicate_event_ignored',
        channel: 'WEBHOOK',
        targetId: eventId,
        targetType: eventType,
      });
      return reply.status(200).send({ received: true, duplicate: true });
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Registra ID evento prima delle mutazioni business
        await tx.processedWorkosEvent.create({
          data: {
            eventId,
            eventType,
            workosCreatedAt: event.createdAt ? new Date(event.createdAt) : null,
          },
        });

        const data = event.data || {};
        let auditReasonCode: AuthAuditReasonCode =
          'webhook_event_processed';

        switch (eventType) {
          case 'user.updated': {
            if (
              data.id &&
              data.email &&
              data.emailVerified === true
            ) {
              const emailNormalized = String(data.email).trim().toLowerCase();
              if (
                emailNormalized.length > 0 &&
                emailNormalized.length <= 255
              ) {
                await tx.platformUser.updateMany({
                  where: { workosUserId: data.id },
                  data: { emailNormalized, lastReconciledAt: new Date() },
                });
              } else {
                auditReasonCode = 'ignored_unmapped';
              }
            } else {
              auditReasonCode = 'ignored_unmapped';
            }
            break;
          }

          case 'user.deleted': {
            if (data.id) {
              const user = await tx.platformUser.findUnique({
                where: { workosUserId: data.id },
              });
              if (!user) {
                auditReasonCode = 'ignored_unmapped';
                break;
              }

              await tx.platformUser.update({
                where: { id: user.id },
                data: {
                  status: 'DEPROVISIONED',
                  lastReconciledAt: new Date(),
                },
              });
              const revokedMemberships =
                await tx.venueMembership.updateMany({
                  where: {
                    userId: user.id,
                    status: { not: 'INACTIVE' },
                  },
                  data: { status: 'INACTIVE' },
                });

              await logAuthAuditEvent(
                tx,
                config.AUTH_AUDIT_HMAC_SECRET,
                {
                  requestId: req.id || `req_${Date.now()}`,
                  action: 'user:deprovisioned',
                  outcome: 'SUCCESS',
                  reasonCode: 'user_deprovisioned',
                  channel: 'WEBHOOK',
                  targetType: 'PlatformUser',
                  targetId: user.id,
                }
              );
              if (revokedMemberships.count > 0) {
                await logAuthAuditEvent(
                  tx,
                  config.AUTH_AUDIT_HMAC_SECRET,
                  {
                    requestId: req.id || `req_${Date.now()}`,
                    action: 'membership:inactivated',
                    outcome: 'SUCCESS',
                    reasonCode:
                      'memberships_inactivated_for_deprovisioned_user',
                    channel: 'WEBHOOK',
                    targetType: 'PlatformUser',
                    targetId: user.id,
                  }
                );
              }
            } else {
              auditReasonCode = 'ignored_unmapped';
            }
            break;
          }

          case 'organization_membership.created':
          case 'organization_membership.updated': {
            if (data.userId && data.organizationId) {
              const user = await tx.platformUser.findUnique({
                where: { workosUserId: data.userId },
              });
              const venue = await tx.venue.findUnique({
                where: { workosOrganizationId: data.organizationId },
              });

              if (user?.status === 'ACTIVE' && venue?.isActive) {
                const workosStatus = (data.status || '').toLowerCase();
                const targetStatus: VenueMembershipStatus =
                  workosStatus === 'active' ? 'ACTIVE' : 'INACTIVE';
                const providerTimestamp = getWorkosObjectTimestamp(data, event.createdAt);

                const existingMembership = await tx.venueMembership.findFirst({
                  where: { userId: user.id, venueId: venue.id },
                });

                if (!existingMembership || !providerTimestamp) {
                  auditReasonCode = 'ignored_unmapped';
                  break;
                }
                if (
                  existingMembership.workosMembershipId &&
                  data.id &&
                  existingMembership.workosMembershipId !== data.id
                ) {
                  auditReasonCode = 'membership_identity_mismatch';
                  break;
                }

                const watermarkRows = await tx.$queryRaw<MembershipWatermark[]>`
                  SELECT
                    "id",
                    "workos_updated_at" AS "workosUpdatedAt"
                  FROM "venue_memberships"
                  WHERE "id" = ${existingMembership.id}
                  FOR UPDATE
                `;
                const watermark = watermarkRows[0]?.workosUpdatedAt ?? null;
                if (watermark && watermark >= providerTimestamp) {
                  auditReasonCode = 'stale_event_ignored';
                  break;
                }

                await tx.venueMembership.update({
                  where: { id: existingMembership.id },
                  data: {
                    workosMembershipId: data.id || existingMembership.workosMembershipId,
                    status: targetStatus,
                    activatedAt:
                      targetStatus === 'ACTIVE'
                        ? existingMembership.activatedAt ?? new Date()
                        : existingMembership.activatedAt,
                  },
                });
                await tx.$executeRaw`
                  UPDATE "venue_memberships"
                  SET "workos_updated_at" = ${providerTimestamp}
                  WHERE "id" = ${existingMembership.id}
                `;
                await logAuthAuditEvent(
                  tx,
                  config.AUTH_AUDIT_HMAC_SECRET,
                  {
                    requestId: req.id || `req_${Date.now()}`,
                    venueId: venue.id,
                    workosOrganizationId: data.organizationId,
                    action:
                      targetStatus === 'ACTIVE'
                        ? 'membership:activated'
                        : 'membership:inactivated',
                    targetType: 'VenueMembership',
                    targetId: existingMembership.id,
                    outcome: 'SUCCESS',
                    reasonCode:
                      targetStatus === 'ACTIVE'
                        ? 'membership_activated'
                        : 'membership_inactivated',
                    channel: 'WEBHOOK',
                  }
                );
              } else {
                auditReasonCode = 'ignored_unmapped';
              }
            } else {
              auditReasonCode = 'ignored_unmapped';
            }
            break;
          }

          case 'organization_membership.deleted': {
            if (data.id) {
              const existingMembership = await tx.venueMembership.findUnique({
                where: { workosMembershipId: data.id },
              });
              const providerTimestamp = getWorkosObjectTimestamp(data, event.createdAt);
              if (!existingMembership || !providerTimestamp) {
                auditReasonCode = 'ignored_unmapped';
                break;
              }

              const watermarkRows = await tx.$queryRaw<MembershipWatermark[]>`
                SELECT
                  "id",
                  "workos_updated_at" AS "workosUpdatedAt"
                FROM "venue_memberships"
                WHERE "id" = ${existingMembership.id}
                FOR UPDATE
              `;
              const watermark = watermarkRows[0]?.workosUpdatedAt ?? null;
              if (watermark && watermark >= providerTimestamp) {
                auditReasonCode = 'stale_event_ignored';
                break;
              }

              await tx.venueMembership.update({
                where: { id: existingMembership.id },
                data: { status: 'INACTIVE' },
              });
              await tx.$executeRaw`
                UPDATE "venue_memberships"
                SET "workos_updated_at" = ${providerTimestamp}
                WHERE "id" = ${existingMembership.id}
              `;
              await logAuthAuditEvent(
                tx,
                config.AUTH_AUDIT_HMAC_SECRET,
                {
                  requestId: req.id || `req_${Date.now()}`,
                  venueId: existingMembership.venueId,
                  action: 'membership:inactivated',
                  targetType: 'VenueMembership',
                  targetId: existingMembership.id,
                  outcome: 'SUCCESS',
                  reasonCode: 'membership_inactivated',
                  channel: 'WEBHOOK',
                }
              );
            } else {
              auditReasonCode = 'ignored_unmapped';
            }
            break;
          }

          default: {
            auditReasonCode = 'ignored_unmapped';
            break;
          }
        }

        await logAuthAuditEvent(tx, config.AUTH_AUDIT_HMAC_SECRET, {
          requestId: req.id || `req_${Date.now()}`,
          action: 'webhook:workos',
          outcome: 'SUCCESS',
          reasonCode: auditReasonCode,
          channel: 'WEBHOOK',
          targetId: eventId,
          targetType: eventType,
        });
      });

      return reply.status(200).send({ received: true });
    } catch {
      // La unique su event_id è l'arbitro dell'idempotenza anche quando due
      // consegne concorrenti superano entrambe il pre-check.
      const concurrentlyProcessed = await prisma.processedWorkosEvent.findUnique({
        where: { eventId },
      });
      if (concurrentlyProcessed) {
        await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
          requestId: req.id || `req_${Date.now()}`,
          action: 'webhook:workos',
          outcome: 'SUCCESS',
          reasonCode: 'duplicate_event_ignored',
          channel: 'WEBHOOK',
          targetId: eventId,
          targetType: eventType,
        });
        return reply.status(200).send({ received: true, duplicate: true });
      }

      await logAuthAuditEvent(prisma, config.AUTH_AUDIT_HMAC_SECRET, {
        requestId: req.id || `req_${Date.now()}`,
        action: 'webhook:workos',
        outcome: 'ERROR',
        reasonCode: 'webhook_transaction_failed',
        channel: 'WEBHOOK',
        targetId: eventId,
        targetType: eventType,
      });
      return reply.status(500).send({ error: 'Errore interno elaborazione webhook WorkOS' });
    }
  });
}
