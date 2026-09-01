-- Alter venue_domains constraint to allow PENDING primary domains
ALTER TABLE "venue_domains" DROP CONSTRAINT IF EXISTS "venue_domain_primary_must_be_verified";
ALTER TABLE "venue_domains" ADD CONSTRAINT "venue_domain_primary_must_be_verified" CHECK (
  "is_primary" = false
  OR (
    "type"::text = 'PLATFORM'
    AND "status"::text IN ('VERIFIED', 'PENDING')
  )
  OR (
    "type"::text = 'CUSTOM'
    AND "status"::text = 'VERIFIED'
  )
);

-- CreateEnum
CREATE TYPE "VenueOnboardingStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "VenueOnboardingStepName" AS ENUM ('OWNER', 'LEGAL', 'DOMAIN', 'CATALOG', 'STRIPE', 'FISCAL', 'OPERATIONS');

-- CreateEnum
CREATE TYPE "VenueOnboardingStepStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'READY');

-- CreateEnum
CREATE TYPE "VenueOnboardingStepSource" AS ENUM ('SYSTEM', 'OWNER', 'PLATFORM_REVIEW', 'PROVIDER', 'LEGACY_BACKFILL');

-- CreateEnum
CREATE TYPE "VenueInvitationStatus" AS ENUM ('PENDING', 'SENT', 'ACCEPTED', 'REVOKED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "IdentityProvisioningKind" AS ENUM ('CREATE_ORGANIZATION', 'SEND_INVITATION', 'REVOKE_INVITATION', 'RESEND_INVITATION');

-- CreateEnum
CREATE TYPE "IdentityProvisioningStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'RETRYABLE', 'FAILED');

-- CreateTable
CREATE TABLE "venue_onboardings" (
    "venue_id" TEXT NOT NULL,
    "status" "VenueOnboardingStatus" NOT NULL DEFAULT 'DRAFT',
    "current_step" "VenueOnboardingStepName",
    "submitted_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "suspended_at" TIMESTAMP(3),
    "reviewed_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_onboardings_pkey" PRIMARY KEY ("venue_id")
);

-- CreateTable
CREATE TABLE "venue_onboarding_steps" (
    "id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "step" "VenueOnboardingStepName" NOT NULL,
    "status" "VenueOnboardingStepStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "source" "VenueOnboardingStepSource" NOT NULL DEFAULT 'SYSTEM',
    "reason_code" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_onboarding_steps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "venue_onboarding_steps_reason_code_check" CHECK (
      "reason_code" IS NULL
      OR (
        "reason_code" = lower(trim("reason_code"))
        AND "reason_code" ~ '^[a-z0-9_]+$'
      )
    )
);

-- CreateTable
CREATE TABLE "venue_invitations" (
    "id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "user_id" TEXT,
    "invited_email_normalized" TEXT NOT NULL,
    "role" "VenueRole" NOT NULL DEFAULT 'OWNER',
    "status" "VenueInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "workos_invitation_id" TEXT,
    "expires_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "venue_invitations_email_check" CHECK (
      length("invited_email_normalized") BETWEEN 1 AND 255
      AND "invited_email_normalized" = lower(trim("invited_email_normalized"))
      AND "invited_email_normalized" LIKE '%@%'
    )
);

-- CreateTable
CREATE TABLE "identity_provisioning_commands" (
    "id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "invitation_id" TEXT,
    "kind" "IdentityProvisioningKind" NOT NULL,
    "status" "IdentityProvisioningStatus" NOT NULL DEFAULT 'PENDING',
    "dedup_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMP(3),
    "last_reason_code" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_provisioning_commands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "identity_provisioning_commands_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "identity_provisioning_commands_dedup_key_check" CHECK (length(trim("dedup_key")) > 0),
    CONSTRAINT "identity_provisioning_commands_request_hash_check" CHECK (length(trim("request_hash")) > 0),
    CONSTRAINT "identity_provisioning_commands_reason_code_check" CHECK (
      "last_reason_code" IS NULL
      OR (
        "last_reason_code" = lower(trim("last_reason_code"))
        AND "last_reason_code" ~ '^[a-z0-9_]+$'
      )
    )
);

-- CreateTable
CREATE TABLE "platform_mutation_receipts" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_mutation_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_mutation_receipts_route_check" CHECK (length(trim("route")) > 0),
    CONSTRAINT "platform_mutation_receipts_dedup_key_check" CHECK (length(trim("dedup_key")) > 0),
    CONSTRAINT "platform_mutation_receipts_request_hash_check" CHECK (length(trim("request_hash")) > 0),
    CONSTRAINT "platform_mutation_receipts_response_status_check" CHECK ("response_status" BETWEEN 100 AND 599)
);

-- CreateIndex
CREATE UNIQUE INDEX "venue_onboarding_steps_venue_id_step_key" ON "venue_onboarding_steps"("venue_id", "step");

-- CreateIndex
CREATE INDEX "venue_onboarding_steps_venue_id_status_idx" ON "venue_onboarding_steps"("venue_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "venue_invitations_workos_invitation_id_key" ON "venue_invitations"("workos_invitation_id");

-- CreateIndex
CREATE INDEX "venue_invitations_venue_id_status_idx" ON "venue_invitations"("venue_id", "status");

-- CreateIndex
CREATE INDEX "venue_invitations_invited_email_normalized_idx" ON "venue_invitations"("invited_email_normalized");

-- CreatePartialUniqueIndex for venue_invitations
CREATE UNIQUE INDEX "venue_invitations_pending_active_email_key" ON "venue_invitations"("venue_id", "invited_email_normalized") WHERE "status" IN ('PENDING', 'SENT');

-- CreateIndex
CREATE UNIQUE INDEX "identity_provisioning_commands_dedup_key_key" ON "identity_provisioning_commands"("dedup_key");

-- CreateIndex
CREATE INDEX "identity_provisioning_commands_status_available_at_idx" ON "identity_provisioning_commands"("status", "available_at");

-- CreateIndex
CREATE INDEX "identity_provisioning_commands_lease_until_idx" ON "identity_provisioning_commands"("lease_until");

-- CreateIndex
CREATE INDEX "identity_provisioning_commands_venue_id_idx" ON "identity_provisioning_commands"("venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_mutation_receipts_dedup_key_key" ON "platform_mutation_receipts"("dedup_key");

-- CreateIndex
CREATE INDEX "platform_mutation_receipts_actor_user_id_created_at_idx" ON "platform_mutation_receipts"("actor_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "venue_onboardings" ADD CONSTRAINT "venue_onboardings_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_onboardings" ADD CONSTRAINT "venue_onboardings_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_onboarding_steps" ADD CONSTRAINT "venue_onboarding_steps_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_invitations" ADD CONSTRAINT "venue_invitations_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_invitations" ADD CONSTRAINT "venue_invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_invitations" ADD CONSTRAINT "venue_invitations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_provisioning_commands" ADD CONSTRAINT "identity_provisioning_commands_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_provisioning_commands" ADD CONSTRAINT "identity_provisioning_commands_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "venue_invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_mutation_receipts" ADD CONSTRAINT "platform_mutation_receipts_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- BACKFILL LEGACY DATA FOR PREEXISTING VENUES
-- Active venues -> onboarding status ACTIVE, 7 steps READY with source LEGACY_BACKFILL and reason code preexisting_active_venue
INSERT INTO "venue_onboardings" ("venue_id", "status", "activated_at", "created_at", "updated_at")
SELECT "id", 'ACTIVE'::"VenueOnboardingStatus", "created_at", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "venues"
WHERE "is_active" = true;

INSERT INTO "venue_onboarding_steps" ("id", "venue_id", "step", "status", "source", "reason_code", "completed_at", "created_at", "updated_at")
SELECT gen_random_uuid()::text, v."id", s."step"::"VenueOnboardingStepName", 'READY'::"VenueOnboardingStepStatus", 'LEGACY_BACKFILL'::"VenueOnboardingStepSource", 'preexisting_active_venue', v."created_at", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "venues" v
CROSS JOIN (
  VALUES ('OWNER'), ('LEGAL'), ('DOMAIN'), ('CATALOG'), ('STRIPE'), ('FISCAL'), ('OPERATIONS')
) AS s("step")
WHERE v."is_active" = true;

-- Inactive venues -> onboarding status DRAFT, steps derived only from reliable local facts
INSERT INTO "venue_onboardings" ("venue_id", "status", "created_at", "updated_at")
SELECT "id", 'DRAFT'::"VenueOnboardingStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "venues"
WHERE "is_active" = false;

INSERT INTO "venue_onboarding_steps" ("id", "venue_id", "step", "status", "source", "reason_code", "completed_at", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  v."id",
  s."step"::"VenueOnboardingStepName",
  CASE s."step"
    WHEN 'OWNER' THEN CASE WHEN EXISTS (
      SELECT 1 FROM "venue_memberships" vm
      JOIN "platform_users" pu ON pu."id" = vm."user_id"
      WHERE vm."venue_id" = v."id" AND vm."role" = 'OWNER' AND vm."status" = 'ACTIVE' AND pu."status" = 'ACTIVE'
    ) THEN 'READY' ELSE 'IN_PROGRESS' END
    WHEN 'DOMAIN' THEN CASE WHEN EXISTS (
      SELECT 1 FROM "venue_domains" vd
      WHERE vd."venue_id" = v."id" AND vd."type" = 'PLATFORM' AND vd."status" = 'VERIFIED' AND vd."is_primary" = true
    ) THEN 'READY' ELSE 'IN_PROGRESS' END
    WHEN 'CATALOG' THEN CASE WHEN EXISTS (
      SELECT 1 FROM "products" p
      WHERE p."venue_id" = v."id" AND p."active" = true AND p."price" > 0 AND p."vat_rate" >= 0
    ) THEN 'READY' ELSE 'NOT_STARTED' END
    WHEN 'LEGAL' THEN CASE WHEN v."vat_number" IS NOT NULL AND v."fiscal_address" IS NOT NULL AND v."fiscal_city" IS NOT NULL AND v."fiscal_zip" IS NOT NULL THEN 'BLOCKED' ELSE 'IN_PROGRESS' END
    ELSE 'BLOCKED'
  END::"VenueOnboardingStepStatus",
  'LEGACY_BACKFILL'::"VenueOnboardingStepSource",
  CASE s."step"
    WHEN 'OWNER' THEN CASE WHEN EXISTS (
      SELECT 1 FROM "venue_memberships" vm
      JOIN "platform_users" pu ON pu."id" = vm."user_id"
      WHERE vm."venue_id" = v."id" AND vm."role" = 'OWNER' AND vm."status" = 'ACTIVE' AND pu."status" = 'ACTIVE'
    ) THEN NULL ELSE 'missing_owner_membership' END
    WHEN 'DOMAIN' THEN CASE WHEN EXISTS (
      SELECT 1 FROM "venue_domains" vd
      WHERE vd."venue_id" = v."id" AND vd."type" = 'PLATFORM' AND vd."status" = 'VERIFIED' AND vd."is_primary" = true
    ) THEN NULL ELSE 'unverified_platform_domain' END
    WHEN 'CATALOG' THEN CASE WHEN EXISTS (
      SELECT 1 FROM "products" p
      WHERE p."venue_id" = v."id" AND p."active" = true AND p."price" > 0 AND p."vat_rate" >= 0
    ) THEN NULL ELSE 'missing_catalog_products' END
    WHEN 'LEGAL' THEN CASE WHEN v."vat_number" IS NOT NULL AND v."fiscal_address" IS NOT NULL AND v."fiscal_city" IS NOT NULL AND v."fiscal_zip" IS NOT NULL THEN 'legal_review_required' ELSE 'legal_info_incomplete' END
    WHEN 'OPERATIONS' THEN 'operations_review_required'
    WHEN 'STRIPE' THEN 'stripe_not_ready'
    WHEN 'FISCAL' THEN 'fiscal_not_ready'
  END,
  CASE
    WHEN s."step" = 'OWNER' AND EXISTS (
      SELECT 1 FROM "venue_memberships" vm
      JOIN "platform_users" pu ON pu."id" = vm."user_id"
      WHERE vm."venue_id" = v."id" AND vm."role" = 'OWNER' AND vm."status" = 'ACTIVE' AND pu."status" = 'ACTIVE'
    ) THEN CURRENT_TIMESTAMP
    WHEN s."step" = 'DOMAIN' AND EXISTS (
      SELECT 1 FROM "venue_domains" vd
      WHERE vd."venue_id" = v."id" AND vd."type" = 'PLATFORM' AND vd."status" = 'VERIFIED' AND vd."is_primary" = true
    ) THEN CURRENT_TIMESTAMP
    WHEN s."step" = 'CATALOG' AND EXISTS (
      SELECT 1 FROM "products" p
      WHERE p."venue_id" = v."id" AND p."active" = true AND p."price" > 0 AND p."vat_rate" >= 0
    ) THEN CURRENT_TIMESTAMP
    ELSE NULL
  END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "venues" v
CROSS JOIN (
  VALUES ('OWNER'), ('LEGAL'), ('DOMAIN'), ('CATALOG'), ('STRIPE'), ('FISCAL'), ('OPERATIONS')
) AS s("step")
WHERE v."is_active" = false;
