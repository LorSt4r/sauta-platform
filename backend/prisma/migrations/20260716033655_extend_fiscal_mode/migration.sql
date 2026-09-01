/*
  Warnings:

  - You are about to drop the column `consent_timestamp` on the `checkout_sessions` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "checkout_sessions" DROP COLUMN "consent_timestamp",
ADD COLUMN     "digital_consent_timestamp" TIMESTAMP(3),
ADD COLUMN     "fiscal_receipt_url" TEXT;

-- AlterTable
ALTER TABLE "venues" ADD COLUMN     "acube_api_key" TEXT,
ADD COLUMN     "acube_organization_id" TEXT,
ADD COLUMN     "fiscal_mode" TEXT NOT NULL DEFAULT 'edge_relay';
