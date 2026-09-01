-- AlterTable
ALTER TABLE "checkout_sessions" ADD COLUMN     "consent_timestamp" TIMESTAMP(3),
ALTER COLUMN "digital_consent" SET DEFAULT false;
