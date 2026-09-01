import crypto from 'node:crypto';
import type {
  Prisma,
  PrismaClient,
  AuthAuditOutcome,
  AuthAuditChannel,
} from '@prisma/client';

export type AuthAuditAction =
  | 'auth:callback'
  | 'auth:login_initiated'
  | 'membership:activated'
  | 'membership:inactivated'
  | 'organization:switch'
  | 'platform:access'
  | 'session:authenticate'
  | 'user:deprovisioned'
  | 'user:linked'
  | 'user:login'
  | 'user:logout'
  | 'venue:access'
  | 'webhook:workos'
  | 'venue:draft_created'
  | 'provisioning:queued'
  | 'provisioning:claimed'
  | 'provisioning:succeeded'
  | 'provisioning:retryable'
  | 'provisioning:failed'
  | 'organization:mapped'
  | 'invitation:queued'
  | 'invitation:sent'
  | 'invitation:reconciled'
  | 'invitation:resent'
  | 'invitation:revoked'
  | 'invitation:email_mismatch'
  | 'onboarding:step_updated'
  | 'onboarding:reviewed'
  | 'onboarding:access'
  | 'onboarding:profile_update'
  | 'venue:activation_denied'
  | 'venue:activated';

export type AuthAuditReasonCode =
  | 'activation_readiness_failed'
  | 'ambiguous_multiple_invitation_candidates'
  | 'code_exchange_failed'
  | 'csrf_validation_failed'
  | 'duplicate_event_ignored'
  | 'email_not_verified'
  | 'email_unverified_session'
  | 'identity_link_collision_or_not_invited'
  | 'ignored_unmapped'
  | 'insufficient_onboarding_owner_permission'
  | 'insufficient_platform_permission'
  | 'insufficient_venue_permission'
  | 'invalid_or_expired_session'
  | 'invalid_webhook_signature'
  | 'invitation_mapping_conflict'
  | 'invitation_provider_mismatch'
  | 'invitation_record_missing'
  | 'invitation_reconciled_successfully'
  | 'invitation_resend_queued'
  | 'invitation_resent_successfully'
  | 'invitation_revoke_queued'
  | 'invitation_revoked_successfully'
  | 'invitation_send_ambiguous'
  | 'invitation_send_queued'
  | 'invitation_sent_successfully'
  | 'invitation_state_conflict'
  | 'invitation_verified_email_mismatch'
  | 'invited_user_linked'
  | 'invited_user_not_found'
  | 'invited_user_organization_missing'
  | 'login_started'
  | 'login_successful'
  | 'manual_retry_queued'
  | 'maximum_attempts_exhausted'
  | 'membership_activated'
  | 'membership_identity_mismatch'
  | 'membership_inactivated'
  | 'memberships_inactivated_for_deprovisioned_user'
  | 'membership_inactive_or_not_found'
  | 'missing_code_or_provider_error'
  | 'missing_session_cookie'
  | 'missing_signature_header'
  | 'no_organization_selected'
  | 'onboarding_draft_to_in_progress'
  | 'onboarding_in_progress_to_ready_for_review'
  | 'onboarding_ready_for_review_to_in_progress'
  | 'onboarding_suspended'
  | 'onboarding_not_initialized'
  | 'organization_create_ambiguous'
  | 'organization_create_queued'
  | 'organization_external_id_mismatch'
  | 'organization_mapping_conflict'
  | 'organization_mapped_successfully'
  | 'organization_not_mapped_yet'
  | 'organization_required_for_venue_user'
  | 'organization_switched'
  | 'organization_unknown_or_venue_inactive'
  | 'owner_invitation_accepted'
  | 'owner_invitation_created'
  | 'pending_membership_not_found'
  | 'profile_fields_updated'
  | 'provider_refresh_mismatch_or_failed'
  | 'provisioning_command_claimed'
  | 'review_legal_blocked'
  | 'review_legal_ready'
  | 'review_operations_blocked'
  | 'review_operations_ready'
  | 'session_cookie_invalid_signature'
  | 'stale_event_ignored'
  | 'state_mismatch'
  | 'target_venue_not_found_or_inactive'
  | 'transient_cookie_expired'
  | 'transient_cookie_invalid_payload'
  | 'transient_cookie_invalid_signature'
  | 'transient_cookie_malformed'
  | 'transient_cookie_missing'
  | 'unknown_command_kind'
  | 'user_deprovisioned'
  | 'user_inactive_or_not_found'
  | 'user_logged_out'
  | 'user_not_authorized_or_inactive'
  | 'user_suspended_or_deprovisioned'
  | 'venue_activated_successfully'
  | 'venue_draft_created_successfully'
  | 'venue_inactive_or_not_found'
  | 'venue_not_found'
  | 'verified_email_collision'
  | 'verified_email_invalid'
  | 'verified_email_session_mismatch'
  | 'webhook_event_processed'
  | 'webhook_transaction_failed'
  | 'workos_invitation_id_missing_for_resend'
  | 'workos_provider_unavailable'
  | 'workos_resend_ambiguous_failure';

export interface AuditEventInput {
  requestId: string;
  actorUserId?: string | null | undefined;
  actorWorkosUserId?: string | null | undefined;
  venueId?: string | null | undefined;
  workosOrganizationId?: string | null | undefined;
  action: AuthAuditAction;
  targetType?: string | null | undefined;
  targetId?: string | null | undefined;
  permission?: string | null | undefined;
  outcome: AuthAuditOutcome;
  reasonCode: AuthAuditReasonCode;
  channel: AuthAuditChannel;
  sessionId?: string | null | undefined;
  originInfo?: { ip?: string; userAgent?: string } | null | undefined;
}

export function computeAuditHmac(value: string, secret: string, domain: string): string {
  if (!value) return '';
  return crypto
    .createHmac('sha256', secret)
    .update(`${domain}:${value}`)
    .digest('hex')
    .substring(0, 32);
}

export async function logAuthAuditEvent(
  prismaOrTx:
    | Pick<PrismaClient, 'authAuditEvent'>
    | Pick<Prisma.TransactionClient, 'authAuditEvent'>,
  secret: string,
  input: AuditEventInput
): Promise<void> {
  const sessionIdHash = input.sessionId
    ? computeAuditHmac(input.sessionId, secret, 'session')
    : null;

  const originRaw = input.originInfo
    ? `${input.originInfo.ip || ''}|${input.originInfo.userAgent || ''}`
    : null;

  const originFingerprint = originRaw
    ? computeAuditHmac(originRaw, secret, 'origin')
    : null;

  await prismaOrTx.authAuditEvent.create({
    data: {
      schemaVersion: 1,
      requestId: input.requestId,
      actorUserId: input.actorUserId || null,
      actorWorkosUserId: input.actorWorkosUserId || null,
      venueId: input.venueId || null,
      workosOrganizationId: input.workosOrganizationId || null,
      action: input.action,
      targetType: input.targetType || null,
      targetId: input.targetId || null,
      permission: input.permission || null,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      channel: input.channel,
      sessionIdHash,
      originFingerprint,
    },
  });
}
