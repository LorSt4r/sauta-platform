-- CreateTable
CREATE TABLE "wallet_capabilities" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "wallet_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_capabilities_session_id_key" ON "wallet_capabilities"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_capabilities_token_hash_key" ON "wallet_capabilities"("token_hash");

-- AddForeignKey
ALTER TABLE "wallet_capabilities" ADD CONSTRAINT "wallet_capabilities_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "checkout_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
