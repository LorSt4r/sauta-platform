-- AlterTable
ALTER TABLE "checkout_sessions" ADD COLUMN     "fiscal_doc_number" TEXT,
ADD COLUMN     "fiscal_status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "fiscal_zeta_number" TEXT,
ADD COLUMN     "payment_method" TEXT,
ADD COLUMN     "payment_terminal_id" TEXT,
ADD COLUMN     "voided_at" TIMESTAMP(3),
ADD COLUMN     "voided_by_id" TEXT,
ADD COLUMN     "voided_reason" TEXT;

-- AlterTable
ALTER TABLE "fiscal_logs" ADD COLUMN     "correlative_id" TEXT,
ADD COLUMN     "operation_kind" TEXT NOT NULL DEFAULT 'stampa';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "vat_rate" DOUBLE PRECISION NOT NULL DEFAULT 10.0;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "price_snapshot" INTEGER,
ADD COLUMN     "vat_rate" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
ADD COLUMN     "voided_at" TIMESTAMP(3),
ADD COLUMN     "voided_reason" TEXT;

-- AlterTable
ALTER TABLE "venues" ADD COLUMN     "fiscal_address" TEXT,
ADD COLUMN     "fiscal_city" TEXT,
ADD COLUMN     "fiscal_zip" TEXT,
ADD COLUMN     "vat_number" TEXT;

-- CreateIndex
CREATE INDEX "fiscal_logs_session_id_operation_kind_idx" ON "fiscal_logs"("session_id", "operation_kind");
