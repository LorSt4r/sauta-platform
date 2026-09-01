import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('Wave 9C.0C Migration Proofs (Clean Deploy & Upgrade Deploy 9C.0B -> 9C.0C)', () => {
  let container: StartedPostgreSqlContainer;
  let dbUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('sauta_migration_test_9c0c')
      .withUsername('sauta')
      .withPassword('sauta_pass')
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    dbUrl = `postgresql://sauta:sauta_pass@${host}:${port}/sauta_migration_test_9c0c?schema=public`;

    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await prisma.$connect();
  }, 60000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  function runPrisma(
    args: string[],
    databaseUrl: string,
    cwd: string
  ): string {
    return execFileSync('npx', ['prisma', ...args], {
      cwd,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf-8',
    });
  }

  it('1. Clean Deploy: schema Prisma e migrazioni 9C.0C sono validi e applicabili da zero', async () => {
    const backendRoot = path.resolve(__dirname, '../..');
    const schemaPath = path.resolve(backendRoot, 'prisma/schema.prisma');

    // Deploy all versioned migrations from scratch
    runPrisma(['migrate', 'deploy', `--schema=${schemaPath}`], dbUrl, backendRoot);

    const validateOut = runPrisma(['validate', `--schema=${schemaPath}`], dbUrl, backendRoot);
    expect(validateOut).toContain('is valid');

    const statusOut = runPrisma(
      ['migrate', 'status', `--schema=${schemaPath}`],
      dbUrl,
      backendRoot
    );
    expect(statusOut).toContain('Database schema is up to date');
  }, 40000);

  it('2. Upgrade Deploy Reale (9C.0B -> 9C.0C): popola dati 9C.0B, applica migrazione 9C.0C e verifica integrità e backfill', async () => {
    const upgradeContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('sauta_upgrade_test_9c0c')
      .withUsername('sauta')
      .withPassword('sauta_pass')
      .start();

    const host = upgradeContainer.getHost();
    const port = upgradeContainer.getMappedPort(5432);
    const upgradeDbUrl = `postgresql://sauta:sauta_pass@${host}:${port}/sauta_upgrade_test_9c0c?schema=public`;

    const upgradePrisma = new PrismaClient({ datasources: { db: { url: upgradeDbUrl } } });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sauta-prisma-upgrade-9c0c-'));

    try {
      const backendRoot = path.resolve(__dirname, '../..');
      const migrationsDir = path.resolve(backendRoot, 'prisma/migrations');
      const tempPrismaDir = path.join(tempRoot, 'prisma');
      const tempMigrationsDir = path.join(tempPrismaDir, 'migrations');
      const schemaPath = path.join(tempPrismaDir, 'schema.prisma');
      const targetMigration = '20260728140000_add_venue_onboarding_provisioning';

      fs.mkdirSync(tempMigrationsDir, { recursive: true });
      fs.copyFileSync(path.join(backendRoot, 'prisma/schema.prisma'), schemaPath);
      fs.copyFileSync(
        path.join(migrationsDir, 'migration_lock.toml'),
        path.join(tempMigrationsDir, 'migration_lock.toml')
      );

      const migrationNames = fs
        .readdirSync(migrationsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const targetIndex = migrationNames.indexOf(targetMigration);
      expect(targetIndex).toBeGreaterThan(0);
      const baselineMigrations = migrationNames.slice(0, targetIndex);

      for (const migrationName of baselineMigrations) {
        fs.cpSync(
          path.join(migrationsDir, migrationName),
          path.join(tempMigrationsDir, migrationName),
          { recursive: true }
        );
      }

      // 1. Deploy baseline 9C.0B migrations
      runPrisma(['migrate', 'deploy', `--schema=${schemaPath}`], upgradeDbUrl, backendRoot);
      await upgradePrisma.$connect();

      // Insert pre-existing 9C.0B data: active venue & inactive venue
      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "venues" ("id", "name", "application_fee_percent", "is_active", "created_at", "stripe_charges_enabled", "stripe_payouts_enabled", "workos_organization_id")
        VALUES ('venue_active_legacy', 'Active Legacy Venue', 2.9, true, NOW(), true, true, 'org_legacy_active');
      `);

      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "venues" ("id", "name", "application_fee_percent", "is_active", "created_at", "stripe_charges_enabled", "stripe_payouts_enabled", "vat_number", "fiscal_address", "fiscal_city", "fiscal_zip")
        VALUES ('venue_inactive_legacy', 'Inactive Legacy Venue', 2.9, false, NOW(), false, false, 'IT12345678901', 'Via Upgrade 1', 'Roma', '00100');
      `);

      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "venue_domains" ("id", "venue_id", "hostname", "type", "status", "is_primary", "verified_at", "created_at", "updated_at")
        VALUES ('dom_active_1', 'venue_active_legacy', 'active.sauta.app', 'PLATFORM', 'VERIFIED', true, NOW(), NOW(), NOW());
      `);

      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "venue_domains" ("id", "venue_id", "hostname", "type", "status", "is_primary", "verified_at", "created_at", "updated_at")
        VALUES ('dom_inactive_1', 'venue_inactive_legacy', 'inactive.sauta.app', 'PLATFORM', 'VERIFIED', true, NOW(), NOW(), NOW());
      `);

      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "products" ("id", "venue_id", "slug", "name", "price", "vat_rate", "active")
        VALUES ('prod_inactive_1', 'venue_inactive_legacy', 'upgrade-product', 'Upgrade Product', 900, 10, true);
      `);

      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "checkout_sessions" ("id", "venue_id", "total_amount", "currency", "status", "fiscal_status", "digital_consent", "created_at")
        VALUES ('sess_upgrade_1', 'venue_active_legacy', 1200, 'EUR', 'paid', 'invoiced', true, NOW());
      `);

      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "tickets" ("id", "session_id", "venue_id", "product_name", "price", "status", "created_at")
        VALUES ('tkt_upgrade_1', 'sess_upgrade_1', 'venue_active_legacy', 'Spritz Upgrade', 1200, 'valid', NOW());
      `);

      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "fiscal_logs" ("id", "session_id", "printer_brand", "command_payload", "status_response", "success", "sequence_number", "previous_hash", "hash", "venue_id", "operation_kind")
        VALUES ('flog_upgrade_1', 'sess_upgrade_1', 'SmartReceipt', '{}', 'OK', true, 1, '', 'hash_proof_123', 'venue_active_legacy', 'stampa');
      `);

      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "platform_users" ("id", "email_normalized", "status", "platform_role", "created_at", "updated_at")
        VALUES ('user_legacy_owner', 'owner@legacy.com', 'ACTIVE', 'NONE', NOW(), NOW());
      `);

      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "venue_memberships" ("id", "user_id", "venue_id", "role", "status", "created_at", "updated_at")
        VALUES ('mem_legacy_owner', 'user_legacy_owner', 'venue_active_legacy', 'OWNER', 'ACTIVE', NOW(), NOW());
      `);

      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "venue_memberships" ("id", "user_id", "venue_id", "role", "status", "created_at", "updated_at")
        VALUES ('mem_inactive_owner', 'user_legacy_owner', 'venue_inactive_legacy', 'OWNER', 'ACTIVE', NOW(), NOW());
      `);

      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "auth_audit_events" ("id", "request_id", "actor_user_id", "venue_id", "action", "outcome", "reason_code", "channel", "created_at")
        VALUES ('audit_legacy_1', 'req_legacy_1', 'user_legacy_owner', 'venue_active_legacy', 'user:logged_in', 'SUCCESS', 'login_success', 'USER', NOW());
      `);

      // 2. Upgrade deploy: apply 9C.0C migration
      fs.cpSync(
        path.join(migrationsDir, targetMigration),
        path.join(tempMigrationsDir, targetMigration),
        { recursive: true }
      );
      runPrisma(['migrate', 'deploy', `--schema=${schemaPath}`], upgradeDbUrl, backendRoot);

      const statusOut = runPrisma(
        ['migrate', 'status', `--schema=${schemaPath}`],
        upgradeDbUrl,
        backendRoot
      );
      expect(statusOut).toContain('Database schema is up to date');

      // 3. Verify data preservation & legacy backfill
      const activeVenue = await upgradePrisma.venue.findUnique({
        where: { id: 'venue_active_legacy' },
        include: { onboarding: true, onboardingSteps: true, domains: true },
      });
      expect(activeVenue?.name).toBe('Active Legacy Venue');
      expect(activeVenue?.onboarding?.status).toBe('ACTIVE');
      expect(activeVenue?.onboardingSteps).toHaveLength(7);
      expect(activeVenue?.onboardingSteps.every((s) => s.status === 'READY' && s.source === 'LEGACY_BACKFILL' && s.reasonCode === 'preexisting_active_venue')).toBe(true);

      const inactiveVenue = await upgradePrisma.venue.findUnique({
        where: { id: 'venue_inactive_legacy' },
        include: { onboarding: true, onboardingSteps: true },
      });
      expect(inactiveVenue?.name).toBe('Inactive Legacy Venue');
      expect(inactiveVenue?.onboarding?.status).toBe('DRAFT');
      expect(inactiveVenue?.onboardingSteps).toHaveLength(7);
      const inactiveSteps = new Map(
        inactiveVenue?.onboardingSteps.map((step) => [step.step, step])
      );
      expect(inactiveSteps.get('OWNER')).toMatchObject({
        status: 'READY',
        source: 'LEGACY_BACKFILL',
        reasonCode: null,
      });
      expect(inactiveSteps.get('DOMAIN')).toMatchObject({
        status: 'READY',
        source: 'LEGACY_BACKFILL',
        reasonCode: null,
      });
      expect(inactiveSteps.get('CATALOG')).toMatchObject({
        status: 'READY',
        source: 'LEGACY_BACKFILL',
        reasonCode: null,
      });
      expect(inactiveSteps.get('LEGAL')).toMatchObject({
        status: 'BLOCKED',
        source: 'LEGACY_BACKFILL',
        reasonCode: 'legal_review_required',
      });
      expect(inactiveSteps.get('OPERATIONS')).toMatchObject({
        status: 'BLOCKED',
        source: 'LEGACY_BACKFILL',
        reasonCode: 'operations_review_required',
      });
      expect(inactiveSteps.get('STRIPE')).toMatchObject({
        status: 'BLOCKED',
        source: 'LEGACY_BACKFILL',
        reasonCode: 'stripe_not_ready',
      });
      expect(inactiveSteps.get('FISCAL')).toMatchObject({
        status: 'BLOCKED',
        source: 'LEGACY_BACKFILL',
        reasonCode: 'fiscal_not_ready',
      });

      // Verify preservation of checkouts, tickets, fiscal_logs, users, memberships, audit events
      const sess = await upgradePrisma.checkoutSession.findUnique({ where: { id: 'sess_upgrade_1' } });
      expect(sess?.totalAmount).toBe(1200);

      const tkt = await upgradePrisma.ticket.findUnique({ where: { id: 'tkt_upgrade_1' } });
      expect(tkt?.productName).toBe('Spritz Upgrade');

      const flog = await upgradePrisma.fiscalLog.findUnique({ where: { id: 'flog_upgrade_1' } });
      expect(flog?.hash).toBe('hash_proof_123');

      const user = await upgradePrisma.platformUser.findUnique({ where: { id: 'user_legacy_owner' } });
      expect(user?.emailNormalized).toBe('owner@legacy.com');

      const audit = await upgradePrisma.authAuditEvent.findUnique({ where: { id: 'audit_legacy_1' } });
      expect(audit?.action).toBe('user:logged_in');

      // 4. Verify SQL CHECK constraints & partial unique index in 9C.0C
      // Invalid email CHECK
      await expect(
        upgradePrisma.$executeRawUnsafe(`
          INSERT INTO "venue_invitations" ("id", "venue_id", "invited_email_normalized", "role", "status", "created_by_user_id", "created_at", "updated_at")
          VALUES ('inv_bad_email', 'venue_inactive_legacy', 'not-an-email', 'OWNER', 'PENDING', 'user_legacy_owner', NOW(), NOW());
        `)
      ).rejects.toThrow();

      await expect(
        upgradePrisma.$executeRawUnsafe(`
          INSERT INTO "venue_invitations" ("id", "venue_id", "invited_email_normalized", "role", "status", "created_by_user_id", "created_at", "updated_at")
          VALUES ('inv_bad_normalization', 'venue_inactive_legacy', ' Owner@Example.com ', 'OWNER', 'PENDING', 'user_legacy_owner', NOW(), NOW());
        `)
      ).rejects.toThrow();

      // Invalid attempts CHECK
      await expect(
        upgradePrisma.$executeRawUnsafe(`
          INSERT INTO "identity_provisioning_commands" ("id", "venue_id", "kind", "status", "dedup_key", "request_hash", "attempts", "created_at", "updated_at")
          VALUES ('cmd_bad_attempts', 'venue_inactive_legacy', 'CREATE_ORGANIZATION', 'PENDING', 'dedup_bad', 'reqhash', -1, NOW(), NOW());
        `)
      ).rejects.toThrow();

      await expect(
        upgradePrisma.$executeRawUnsafe(`
          INSERT INTO "identity_provisioning_commands" ("id", "venue_id", "kind", "status", "dedup_key", "request_hash", "attempts", "last_reason_code", "created_at", "updated_at")
          VALUES ('cmd_bad_reason', 'venue_inactive_legacy', 'CREATE_ORGANIZATION', 'FAILED', 'dedup_bad_reason', 'reqhash', 1, 'Bad Reason', NOW(), NOW());
        `)
      ).rejects.toThrow();

      await expect(
        upgradePrisma.$executeRawUnsafe(`
          INSERT INTO "platform_mutation_receipts" ("id", "actor_user_id", "route", "dedup_key", "request_hash", "response_status", "response_body", "created_at", "updated_at")
          VALUES ('receipt_bad_route', 'user_legacy_owner', ' ', 'receipt_dedup', 'receipt_hash', 200, '{}'::jsonb, NOW(), NOW());
        `)
      ).rejects.toThrow();

      await expect(
        upgradePrisma.$executeRawUnsafe(`
          UPDATE "venue_onboardings"
          SET "reviewed_by_user_id" = 'missing_reviewer'
          WHERE "venue_id" = 'venue_inactive_legacy';
        `)
      ).rejects.toThrow();

      await upgradePrisma.$executeRawUnsafe(`
        UPDATE "venue_domains"
        SET "status" = 'PENDING', "verified_at" = NULL
        WHERE "id" = 'dom_inactive_1';
      `);
      await expect(
        upgradePrisma.$executeRawUnsafe(`
          UPDATE "venue_domains"
          SET "type" = 'CUSTOM'
          WHERE "id" = 'dom_inactive_1';
        `)
      ).rejects.toThrow();

      // Partial Unique Index on (venue_id, invited_email_normalized) WHERE status IN ('PENDING', 'SENT')
      await upgradePrisma.$executeRawUnsafe(`
        INSERT INTO "venue_invitations" ("id", "venue_id", "invited_email_normalized", "role", "status", "created_by_user_id", "created_at", "updated_at")
        VALUES ('inv_1', 'venue_inactive_legacy', 'test@example.com', 'OWNER', 'PENDING', 'user_legacy_owner', NOW(), NOW());
      `);

      // Duplicate PENDING invitation to same venue & email must throw
      await expect(
        upgradePrisma.$executeRawUnsafe(`
          INSERT INTO "venue_invitations" ("id", "venue_id", "invited_email_normalized", "role", "status", "created_by_user_id", "created_at", "updated_at")
          VALUES ('inv_2', 'venue_inactive_legacy', 'test@example.com', 'OWNER', 'SENT', 'user_legacy_owner', NOW(), NOW());
        `)
      ).rejects.toThrow();
    } finally {
      await upgradePrisma.$disconnect();
      await upgradeContainer.stop();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120000);
});
