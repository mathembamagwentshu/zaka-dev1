-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'OPERATOR_ALERT';

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "failure_reason" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "merchant_status_events" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulated_refunds" (
    "id" TEXT NOT NULL,
    "intent_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "simulated_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_status_events_dedupe_key_key" ON "merchant_status_events"("dedupe_key");

-- AddForeignKey
ALTER TABLE "merchant_status_events" ADD CONSTRAINT "merchant_status_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "checkout_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Hand-written guards (not expressible in the Prisma schema)
-- ---------------------------------------------------------------------------------------------

-- A card can never be refunded for more than it was charged, or in another currency.
CREATE FUNCTION "refunds_within_allocation"() RETURNS trigger AS $$
DECLARE
  alloc RECORD;
  refunded INTEGER;
BEGIN
  SELECT "amount_minor", "currency" INTO alloc FROM "card_allocations" WHERE "id" = NEW."allocation_id" FOR UPDATE;
  IF NEW."currency" <> alloc."currency" THEN
    RAISE EXCEPTION 'refund currency % differs from card currency %', NEW."currency", alloc."currency";
  END IF;
  SELECT COALESCE(SUM("amount_minor"), 0) INTO refunded FROM "refunds"
    WHERE "allocation_id" = NEW."allocation_id" AND "id" <> NEW."id" AND "status" NOT IN ('failed', 'canceled');
  IF refunded + NEW."amount_minor" > alloc."amount_minor" THEN
    RAISE EXCEPTION 'refunds (%) would exceed the card amount (%)', refunded + NEW."amount_minor", alloc."amount_minor";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refunds_within_allocation" BEFORE INSERT ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION "refunds_within_allocation"();

ALTER TABLE "merchant_status_events" ADD CONSTRAINT "merchant_status_events_attempts_nonnegative" CHECK ("attempts" >= 0);
ALTER TABLE "simulated_refunds" ADD CONSTRAINT "simulated_refunds_amount_positive" CHECK ("amount_minor" > 0);
