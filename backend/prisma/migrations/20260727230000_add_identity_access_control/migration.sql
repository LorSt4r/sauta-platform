-- CreateEnum
CREATE TYPE "PlatformUserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEPROVISIONED');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('NONE', 'PLATFORM_ADMIN');

-- CreateEnum
CREATE TYPE "VenueRole" AS ENUM ('OWNER', 'MANAGER', 'STAFF');

-- CreateEnum
CREATE TYPE "VenueMembershipStatus" AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "AuthAuditOutcome" AS ENUM ('SUCCESS', 'DENIED', 'ERROR');

-- CreateEnum
CREATE TYPE "AuthAuditChannel" AS ENUM ('USER', 'WEBHOOK', 'RECONCILIATION', 'SYSTEM');

-- AlterTable
ALTER TABLE "venues" ADD COLUMN "workos_organization_id" TEXT;

-- CreateTable
CREATE TABLE "platform_users" (
    "id" TEXT NOT NULL,
    "workos_user_id" TEXT,
    "email_normalized" TEXT NOT NULL,
    "status" "PlatformUserStatus" NOT NULL DEFAULT 'INVITED',
    "platform_role" "PlatformRole" NOT NULL DEFAULT 'NONE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_reconciled_at" TIMESTAMP(3),

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "workos_membership_id" TEXT,
    "role" "VenueRole" NOT NULL,
    "status" "VenueMembershipStatus" NOT NULL DEFAULT 'PENDING',
    "activated_at" TIMESTAMP(3),
    "workos_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_workos_events" (
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "workos_created_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_workos_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "auth_audit_events" (
    "id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "request_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_workos_user_id" TEXT,
    "venue_id" TEXT,
    "workos_organization_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "permission" TEXT,
    "outcome" "AuthAuditOutcome" NOT NULL,
    "reason_code" TEXT NOT NULL,
    "channel" "AuthAuditChannel" NOT NULL,
    "session_id_hash" TEXT,
    "origin_fingerprint" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "venues_workos_organization_id_key" ON "venues"("workos_organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_workos_user_id_key" ON "platform_users"("workos_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_normalized_key" ON "platform_users"("email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "venue_memberships_workos_membership_id_key" ON "venue_memberships"("workos_membership_id");

-- CreateIndex
CREATE INDEX "venue_memberships_venue_id_status_idx" ON "venue_memberships"("venue_id", "status");

-- CreateIndex
CREATE INDEX "venue_memberships_user_id_status_idx" ON "venue_memberships"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "venue_memberships_user_id_venue_id_key" ON "venue_memberships"("user_id", "venue_id");

-- CreateIndex
CREATE INDEX "auth_audit_events_venue_id_created_at_idx" ON "auth_audit_events"("venue_id", "created_at");

-- CreateIndex
CREATE INDEX "auth_audit_events_actor_user_id_created_at_idx" ON "auth_audit_events"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "auth_audit_events_action_created_at_idx" ON "auth_audit_events"("action", "created_at");

-- AddForeignKey
ALTER TABLE "venue_memberships" ADD CONSTRAINT "venue_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_memberships" ADD CONSTRAINT "venue_memberships_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_audit_events" ADD CONSTRAINT "auth_audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_audit_events" ADD CONSTRAINT "auth_audit_events_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Check Constraints
ALTER TABLE "platform_users" ADD CONSTRAINT "platform_user_email_normalized_check" CHECK ("email_normalized" = LOWER(TRIM("email_normalized")) AND char_length("email_normalized") > 0 AND char_length("email_normalized") <= 255);
ALTER TABLE "auth_audit_events" ADD CONSTRAINT "auth_audit_event_action_not_empty" CHECK (char_length(BTRIM("action")) > 0);
ALTER TABLE "auth_audit_events" ADD CONSTRAINT "auth_audit_event_request_id_not_empty" CHECK (char_length(BTRIM("request_id")) > 0);
ALTER TABLE "auth_audit_events" ADD CONSTRAINT "auth_audit_event_reason_code_not_empty" CHECK (char_length(BTRIM("reason_code")) > 0);
