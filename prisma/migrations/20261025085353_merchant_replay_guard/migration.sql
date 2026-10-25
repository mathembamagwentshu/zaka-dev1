-- CreateTable
CREATE TABLE "merchant_request_nonces" (
    "signature" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_request_nonces_pkey" PRIMARY KEY ("signature")
);

-- CreateIndex
CREATE INDEX "merchant_request_nonces_created_at_idx" ON "merchant_request_nonces"("created_at");
