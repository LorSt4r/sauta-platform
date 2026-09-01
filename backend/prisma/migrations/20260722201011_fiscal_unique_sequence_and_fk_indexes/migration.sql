/*
  Warnings:

  - A unique constraint covering the columns `[venue_id,sequence_number]` on the table `fiscal_logs` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "fiscal_logs_venue_id_sequence_number_idx";

-- CreateIndex
CREATE INDEX "checkout_sessions_venue_id_idx" ON "checkout_sessions"("venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_logs_venue_id_sequence_number_key" ON "fiscal_logs"("venue_id", "sequence_number");

-- CreateIndex
CREATE INDEX "tickets_session_id_idx" ON "tickets"("session_id");

-- CreateIndex
CREATE INDEX "tickets_venue_id_idx" ON "tickets"("venue_id");
