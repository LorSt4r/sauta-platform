-- CreateEnum
CREATE TYPE "VenueDomainType" AS ENUM ('PLATFORM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "VenueDomainStatus" AS ENUM ('PENDING', 'VERIFIED', 'DISABLED');

-- CreateTable
CREATE TABLE "venue_domains" (
    "id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "type" "VenueDomainType" NOT NULL,
    "status" "VenueDomainStatus" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_domains_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "venues" ALTER COLUMN "is_active" SET DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "venue_domains_hostname_key" ON "venue_domains"("hostname");

-- CreateIndex
CREATE INDEX "venue_domains_venue_id_idx" ON "venue_domains"("venue_id");

-- CreateIndex
CREATE INDEX "venue_domains_status_idx" ON "venue_domains"("status");

-- Partial unique index: at most one primary domain per venue
CREATE UNIQUE INDEX "venue_domain_primary_per_venue_idx" ON "venue_domains"("venue_id") WHERE "is_primary" = true;

-- AddForeignKey
ALTER TABLE "venue_domains" ADD CONSTRAINT "venue_domains_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Check Constraints
ALTER TABLE "venue_domains" ADD CONSTRAINT "venue_domain_primary_must_be_verified" CHECK ("is_primary" = false OR "status"::text = 'VERIFIED');
ALTER TABLE "venue_domains" ADD CONSTRAINT "venue_domain_verified_must_have_verified_at" CHECK ("status"::text != 'VERIFIED' OR "verified_at" IS NOT NULL);
ALTER TABLE "venue_domains" ADD CONSTRAINT "venue_domain_hostname_normalized" CHECK (
    "hostname" = LOWER("hostname")
    AND char_length("hostname") <= 253
    AND "hostname" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
    AND "hostname" !~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
);
