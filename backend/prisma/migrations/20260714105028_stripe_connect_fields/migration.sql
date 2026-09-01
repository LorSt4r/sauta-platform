-- AlterTable
ALTER TABLE "venues" ADD COLUMN     "application_fee_percent" DOUBLE PRECISION NOT NULL DEFAULT 2.9,
ADD COLUMN     "stripe_charges_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripe_onboarded_at" TIMESTAMP(3),
ADD COLUMN     "stripe_payouts_enabled" BOOLEAN NOT NULL DEFAULT false;
