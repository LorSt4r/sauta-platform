-- AlterTable
ALTER TABLE "fiscal_logs" ADD COLUMN     "hash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "previous_hash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "sequence_number" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "venue_id" TEXT;

-- CreateIndex
CREATE INDEX "fiscal_logs_venue_id_sequence_number_idx" ON "fiscal_logs"("venue_id", "sequence_number");
