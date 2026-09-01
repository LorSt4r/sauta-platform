import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startTestDb } from '../db';
import { createFakeIdentityProvider } from '../../src/utils/identityProvider';
import { claimCommand, executeIdentityProvisioningCommand } from '../../src/services/identityProvisioningService';

import { createPrismaClient } from '../../src/utils/prisma';

describe('Identity Provisioning Concurrency & Resilience Tests', () => {
  let prisma: PrismaClient;
  let stopPg: () => Promise<void>;

  beforeAll(async () => {
    const db = await startTestDb();
    prisma = createPrismaClient(db.url);
    stopPg = db.stop;
  }, 60000);

  afterAll(async () => {
    await stopPg?.();
  });

  it('allows only a single worker to claim a command concurrently', async () => {
    const venue = await prisma.venue.create({ data: { name: 'Claim Test Venue', isActive: false } });
    const cmd = await prisma.identityProvisioningCommand.create({
      data: {
        venueId: venue.id,
        kind: 'CREATE_ORGANIZATION',
        status: 'PENDING',
        dedupKey: `dedup_claim_${Date.now()}`,
        requestHash: 'hash_claim',
      },
    });

    const results = await Promise.all([
      claimCommand(prisma, cmd.id),
      claimCommand(prisma, cmd.id),
    ]);

    // Exactly one claim must succeed
    expect(results.filter((r) => r === true)).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(1);

    const reloaded = await prisma.identityProvisioningCommand.findUnique({ where: { id: cmd.id } });
    expect(reloaded?.status).toBe('PROCESSING');
    expect(reloaded?.attempts).toBe(1);
  });

  it('allows an expired lease to be reclaimed', async () => {
    const venue = await prisma.venue.create({ data: { name: 'Lease Test Venue', isActive: false } });
    const pastLease = new Date(Date.now() - 10000); // Expired 10 seconds ago

    const cmd = await prisma.identityProvisioningCommand.create({
      data: {
        venueId: venue.id,
        kind: 'CREATE_ORGANIZATION',
        status: 'PROCESSING',
        leaseUntil: pastLease,
        dedupKey: `dedup_lease_${Date.now()}`,
        requestHash: 'hash_lease',
        attempts: 1,
      },
    });

    const claimed = await claimCommand(prisma, cmd.id);
    expect(claimed).toBe(true);

    const reloaded = await prisma.identityProvisioningCommand.findUnique({ where: { id: cmd.id } });
    expect(reloaded?.attempts).toBe(2);
    expect(reloaded?.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('recovers from WorkOS timeout / lost response on organization creation via externalId lookup', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const venue = await prisma.venue.create({ data: { name: 'Timeout Rec Venue', isActive: false } });
    const externalId = `sauta-venue:${venue.id}`;

    const cmd = await prisma.identityProvisioningCommand.create({
      data: {
        venueId: venue.id,
        kind: 'CREATE_ORGANIZATION',
        status: 'PENDING',
        dedupKey: `dedup_timeout_${Date.now()}`,
        requestHash: 'hash_timeout',
      },
    });

    // Configure fake provider to simulate timeout during createOrganization (which still creates org in fake store)
    fakeIdP.simulateTimeoutOrAmbiguousError = true;

    // Execution attempt recovers from timeout via inline externalId lookup and succeeds cleanly
    const res1 = await executeIdentityProvisioningCommand(prisma, fakeIdP, cmd.id);
    expect(res1.success).toBe(true);
    expect(res1.status).toBe('SUCCEEDED');
    expect(fakeIdP.organizationCreateRequests).toEqual([
      {
        name: venue.name,
        externalId,
        idempotencyKey: cmd.id,
      },
    ]);

    const updatedVenue = await prisma.venue.findUnique({ where: { id: venue.id } });
    expect(updatedVenue?.workosOrganizationId).toBeDefined();
  });

  it('marks ambiguous resend failure as terminal FAILED without automatic retry', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const venue = await prisma.venue.create({
      data: { name: 'Resend Failure Venue', isActive: false, workosOrganizationId: `org_resend_${Date.now()}` },
    });

    const user = await prisma.platformUser.create({
      data: { emailNormalized: `resend_${Date.now()}@sauta.test`, status: 'INVITED' },
    });

    const invitation = await prisma.venueInvitation.create({
      data: {
        venueId: venue.id,
        invitedEmailNormalized: user.emailNormalized,
        role: 'OWNER',
        status: 'SENT',
        workosInvitationId: `wos_inv_resend_${Date.now()}`,
        createdByUserId: user.id,
      },
    });

    const cmd = await prisma.identityProvisioningCommand.create({
      data: {
        venueId: venue.id,
        invitationId: invitation.id,
        kind: 'RESEND_INVITATION',
        status: 'PENDING',
        dedupKey: `dedup_resend_fail_${Date.now()}`,
        requestHash: 'hash_resend',
      },
    });

    fakeIdP.simulateResendAmbiguousFailure = true;

    const res = await executeIdentityProvisioningCommand(prisma, fakeIdP, cmd.id);
    expect(res.success).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.reasonCode).toBe('workos_resend_ambiguous_failure');

    const updatedCmd = await prisma.identityProvisioningCommand.findUnique({ where: { id: cmd.id } });
    expect(updatedCmd?.status).toBe('FAILED');
  });

  it('reconciles a lost SEND_INVITATION response by exact organization and email before retrying', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const organizationId = `org_send_reconcile_${Date.now()}`;
    fakeIdP.organizations.set(organizationId, {
      id: organizationId,
      name: 'Send Reconcile Org',
      externalId: 'sauta-venue:send-reconcile',
    });
    const venue = await prisma.venue.create({
      data: {
        name: 'Send Reconcile Venue',
        isActive: false,
        workosOrganizationId: organizationId,
      },
    });
    const creator = await prisma.platformUser.create({
      data: {
        emailNormalized: `creator_send_${Date.now()}@sauta.test`,
        status: 'ACTIVE',
        platformRole: 'PLATFORM_ADMIN',
      },
    });
    const invitedEmail = `owner_send_${Date.now()}@sauta.test`;
    const invitation = await prisma.venueInvitation.create({
      data: {
        venueId: venue.id,
        invitedEmailNormalized: invitedEmail,
        role: 'OWNER',
        status: 'PENDING',
        createdByUserId: creator.id,
      },
    });
    const command = await prisma.identityProvisioningCommand.create({
      data: {
        venueId: venue.id,
        invitationId: invitation.id,
        kind: 'SEND_INVITATION',
        status: 'PENDING',
        dedupKey: `dedup_send_reconcile_${Date.now()}`,
        requestHash: 'hash_send_reconcile',
      },
    });
    fakeIdP.simulateSendTimeoutOrAmbiguousError = true;

    const result = await executeIdentityProvisioningCommand(
      prisma,
      fakeIdP,
      command.id
    );
    expect(result).toMatchObject({ success: true, status: 'SUCCEEDED' });
    expect(fakeIdP.invitationSendRequests).toEqual([
      { organizationId, email: invitedEmail },
    ]);
    expect(
      (await prisma.venueInvitation.findUnique({ where: { id: invitation.id } }))
        ?.status
    ).toBe('SENT');
    expect(
      await prisma.authAuditEvent.findFirst({
        where: {
          venueId: venue.id,
          action: 'invitation:reconciled',
        },
      })
    ).not.toBeNull();
  });

  it('fails closed when multiple exact pending provider invitations are ambiguous', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const organizationId = `org_send_ambiguous_${Date.now()}`;
    const venue = await prisma.venue.create({
      data: {
        name: 'Ambiguous Invitation Venue',
        isActive: false,
        workosOrganizationId: organizationId,
      },
    });
    const creator = await prisma.platformUser.create({
      data: {
        emailNormalized: `creator_ambiguous_${Date.now()}@sauta.test`,
        status: 'ACTIVE',
        platformRole: 'PLATFORM_ADMIN',
      },
    });
    const invitedEmail = `owner_ambiguous_${Date.now()}@sauta.test`;
    const invitation = await prisma.venueInvitation.create({
      data: {
        venueId: venue.id,
        invitedEmailNormalized: invitedEmail,
        role: 'OWNER',
        status: 'PENDING',
        createdByUserId: creator.id,
      },
    });
    for (const id of ['inv_ambiguous_a', 'inv_ambiguous_b']) {
      fakeIdP.invitations.set(`${id}_${Date.now()}`, {
        id: `${id}_${Date.now()}`,
        organizationId,
        email: invitedEmail,
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }
    const command = await prisma.identityProvisioningCommand.create({
      data: {
        venueId: venue.id,
        invitationId: invitation.id,
        kind: 'SEND_INVITATION',
        status: 'PENDING',
        dedupKey: `dedup_send_ambiguous_${Date.now()}`,
        requestHash: 'hash_send_ambiguous',
      },
    });

    const result = await executeIdentityProvisioningCommand(
      prisma,
      fakeIdP,
      command.id
    );
    expect(result).toEqual({
      success: false,
      status: 'FAILED',
      reasonCode: 'ambiguous_multiple_invitation_candidates',
    });
    expect(fakeIdP.invitationSendRequests).toHaveLength(0);
  });

  it('marks an exhausted command terminal without another provider call', async () => {
    const fakeIdP = createFakeIdentityProvider();
    const venue = await prisma.venue.create({
      data: { name: 'Exhausted Command Venue', isActive: false },
    });
    const command = await prisma.identityProvisioningCommand.create({
      data: {
        venueId: venue.id,
        kind: 'CREATE_ORGANIZATION',
        status: 'RETRYABLE',
        attempts: 5,
        availableAt: new Date(Date.now() - 1_000),
        dedupKey: `dedup_exhausted_${Date.now()}`,
        requestHash: 'hash_exhausted',
      },
    });

    const result = await executeIdentityProvisioningCommand(
      prisma,
      fakeIdP,
      command.id
    );
    expect(result).toEqual({
      success: false,
      status: 'FAILED',
      reasonCode: 'maximum_attempts_exhausted',
    });
    expect(fakeIdP.organizationCreateRequests).toHaveLength(0);
  });

  it('verifies that no tokens, secrets or accept URLs exist in DTOs or DB', async () => {
    const invitations = await prisma.venueInvitation.findMany();
    const commands = await prisma.identityProvisioningCommand.findMany();

    for (const inv of invitations) {
      expect((inv as any).token).toBeUndefined();
      expect((inv as any).acceptUrl).toBeUndefined();
      expect((inv as any).accept_invitation_url).toBeUndefined();
    }

    for (const cmd of commands) {
      expect((cmd as any).token).toBeUndefined();
      expect((cmd as any).secret).toBeUndefined();
    }
  });
});
