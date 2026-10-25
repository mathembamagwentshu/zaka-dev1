-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('STANDALONE', 'CONTRIBUTOR');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('OPEN', 'AWAITING_PAYMENT', 'CAPTURING', 'COMPLETED', 'CAPTURE_EXCEPTION', 'REVERSED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('SHOPPER', 'INITIATOR', 'CONTRIBUTOR');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'AUTHORISED', 'CAPTURED', 'FAILED', 'RELEASED');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('PENDING', 'INTENT_CREATED', 'REQUIRES_ACTION', 'AUTHORISED', 'CAPTURED', 'FAILED', 'RELEASED', 'CAPTURE_FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OperationKind" AS ENUM ('CREATE_INTENT', 'CAPTURE', 'CANCEL', 'REFUND');

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('INVITATION', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'OUTBOX', 'SUPPRESSED', 'FAILED');

-- CreateTable
CREATE TABLE "merchant_orders" (
    "id" UUID NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "cart_version" TEXT NOT NULL,
    "description" TEXT,
    "return_url" TEXT,
    "paid_session_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_sessions" (
    "id" UUID NOT NULL,
    "public_ref" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "mode" "PaymentMode",
    "status" "SessionStatus" NOT NULL DEFAULT 'OPEN',
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "cart_version" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "provider_kind" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "locked_at" TIMESTAMP(3),
    "lock_request_key" TEXT,
    "terminal_at" TIMESTAMP(3),
    "terminal_reason" TEXT,
    "capture_started_at" TIMESTAMP(3),
    "fault_plan" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participants" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" "ParticipantRole" NOT NULL,
    "position" INTEGER NOT NULL,
    "display_name" TEXT,
    "email" TEXT,
    "obligation_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "current_attempt_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "participant_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "card_count" INTEGER NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "request_key" TEXT,
    "failure_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_allocations" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "participant_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "AllocationStatus" NOT NULL DEFAULT 'PENDING',
    "provider_kind" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "provider_intent_id" TEXT,
    "provider_status" TEXT,
    "card_brand" TEXT,
    "card_last4" TEXT,
    "auth_expires_at" TIMESTAMP(3),
    "failure_code" TEXT,
    "failure_message" TEXT,
    "authorised_at" TIMESTAMP(3),
    "captured_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_operations" (
    "id" UUID NOT NULL,
    "allocation_id" UUID NOT NULL,
    "kind" "OperationKind" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "OperationStatus" NOT NULL DEFAULT 'PENDING',
    "amount_minor" INTEGER,
    "currency" CHAR(3),
    "provider_ref" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "allocation_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "provider_refund_id" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "participant_id" UUID NOT NULL,
    "role" "ParticipantRole" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_encrypted" TEXT,
    "can_pay" BOOLEAN NOT NULL,
    "can_manage" BOOLEAN NOT NULL,
    "pay_expires_at" TIMESTAMP(3) NOT NULL,
    "view_expires_at" TIMESTAMP(3) NOT NULL,
    "pay_revoked_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "account" TEXT,
    "livemode" BOOLEAN NOT NULL,
    "object_id" TEXT,
    "outcome" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "participant_id" UUID,
    "kind" "NotificationKind" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "session_id" UUID,
    "participant_id" UUID,
    "allocation_id" UUID,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulated_intents" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "client_secret" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "card_brand" TEXT,
    "card_last4" TEXT,
    "capture_before" TIMESTAMP(3),
    "amount_received" INTEGER NOT NULL DEFAULT 0,
    "amount_refunded" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "simulated_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulated_idempotency" (
    "key" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulated_idempotency_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_orders_paid_session_id_key" ON "merchant_orders"("paid_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_orders_merchant_id_external_ref_key" ON "merchant_orders"("merchant_id", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_sessions_public_ref_key" ON "checkout_sessions"("public_ref");

-- CreateIndex
CREATE INDEX "checkout_sessions_order_id_idx" ON "checkout_sessions"("order_id");

-- CreateIndex
CREATE INDEX "checkout_sessions_status_expires_at_idx" ON "checkout_sessions"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "participants_current_attempt_id_key" ON "participants"("current_attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "participants_session_id_position_key" ON "participants"("session_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_participant_id_attempt_number_key" ON "payment_attempts"("participant_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_participant_id_request_key_key" ON "payment_attempts"("participant_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "card_allocations_provider_intent_id_key" ON "card_allocations"("provider_intent_id");

-- CreateIndex
CREATE INDEX "card_allocations_session_id_idx" ON "card_allocations"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "card_allocations_attempt_id_position_key" ON "card_allocations"("attempt_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "provider_operations_idempotency_key_key" ON "provider_operations"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_provider_refund_id_key" ON "refunds"("provider_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_tokens_token_hash_key" ON "access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "access_tokens_session_id_idx" ON "access_tokens"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "audit_events_session_id_id_idx" ON "audit_events"("session_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "simulated_intents_client_secret_key" ON "simulated_intents"("client_secret");

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "merchant_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participants" ADD CONSTRAINT "participants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "checkout_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "checkout_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_allocations" ADD CONSTRAINT "card_allocations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "checkout_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_allocations" ADD CONSTRAINT "card_allocations_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_allocations" ADD CONSTRAINT "card_allocations_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operations_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "card_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "card_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "checkout_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "checkout_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "checkout_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written financial guards (not expressible in the Prisma schema).
-- ---------------------------------------------------------------------------

ALTER TABLE "merchant_orders"   ADD CONSTRAINT "merchant_orders_amount_positive"   CHECK ("amount_minor" > 0),
                                ADD CONSTRAINT "merchant_orders_currency_iso"      CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_amount_positive" CHECK ("amount_minor" > 0),
                                ADD CONSTRAINT "checkout_sessions_currency_iso"    CHECK ("currency" ~ '^[A-Z]{3}$'),
                                ADD CONSTRAINT "checkout_sessions_version_positive" CHECK ("version" > 0);
ALTER TABLE "participants"      ADD CONSTRAINT "participants_obligation_positive"  CHECK ("obligation_minor" > 0),
                                ADD CONSTRAINT "participants_position_range"       CHECK ("position" BETWEEN 1 AND 2);
ALTER TABLE "payment_attempts"  ADD CONSTRAINT "payment_attempts_amount_positive"  CHECK ("amount_minor" > 0),
                                ADD CONSTRAINT "payment_attempts_card_count_range" CHECK ("card_count" BETWEEN 1 AND 2);
ALTER TABLE "card_allocations"  ADD CONSTRAINT "card_allocations_amount_positive"  CHECK ("amount_minor" > 0),
                                ADD CONSTRAINT "card_allocations_position_range"   CHECK ("position" BETWEEN 1 AND 2);
ALTER TABLE "refunds"           ADD CONSTRAINT "refunds_amount_positive"           CHECK ("amount_minor" > 0);

-- At most one live checkout per merchant order: prevents two sessions/modes funding one order.
CREATE UNIQUE INDEX "checkout_sessions_one_live_per_order" ON "checkout_sessions" ("order_id")
  WHERE "status" IN ('OPEN', 'AWAITING_PAYMENT', 'CAPTURING', 'CAPTURE_EXCEPTION');

-- At most one live payment attempt per payer.
CREATE UNIQUE INDEX "payment_attempts_one_live_per_participant" ON "payment_attempts" ("participant_id")
  WHERE "status" IN ('IN_PROGRESS', 'AUTHORISED');

-- Deferred invariants, checked at commit:
--   sum(participant obligations) = session amount (same currency)
--   sum(card allocations of an attempt) = attempt amount = participant obligation (same currency)
CREATE FUNCTION zaka_check_session_obligations() RETURNS trigger AS $$
DECLARE
  sid uuid := COALESCE(NEW."session_id", OLD."session_id");
  total int; cur char(3); obligation_sum int; mismatched int;
BEGIN
  SELECT "amount_minor", "currency" INTO total, cur FROM "checkout_sessions" WHERE "id" = sid;
  SELECT COALESCE(SUM("obligation_minor"), 0), COUNT(*) FILTER (WHERE "currency" <> cur)
    INTO obligation_sum, mismatched FROM "participants" WHERE "session_id" = sid;
  IF obligation_sum <> 0 AND (obligation_sum <> total OR mismatched > 0) THEN
    RAISE EXCEPTION 'obligations (%) do not equal session total (%) in %', obligation_sum, total, cur
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "participants_obligations_sum" AFTER INSERT OR UPDATE OR DELETE ON "participants"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zaka_check_session_obligations();

CREATE FUNCTION zaka_check_attempt_allocations() RETURNS trigger AS $$
DECLARE
  aid uuid := COALESCE(NEW."attempt_id", OLD."attempt_id");
  attempt_amount int; attempt_currency char(3); obligation int; alloc_sum int; mismatched int;
BEGIN
  SELECT a."amount_minor", a."currency", p."obligation_minor" INTO attempt_amount, attempt_currency, obligation
    FROM "payment_attempts" a JOIN "participants" p ON p."id" = a."participant_id" WHERE a."id" = aid;
  SELECT COALESCE(SUM("amount_minor"), 0), COUNT(*) FILTER (WHERE "currency" <> attempt_currency)
    INTO alloc_sum, mismatched FROM "card_allocations" WHERE "attempt_id" = aid;
  IF alloc_sum <> attempt_amount OR attempt_amount <> obligation OR mismatched > 0 THEN
    RAISE EXCEPTION 'card allocations (%) do not equal payer obligation (%)', alloc_sum, obligation
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "card_allocations_sum" AFTER INSERT OR UPDATE OF "amount_minor", "currency" OR DELETE ON "card_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zaka_check_attempt_allocations();

-- Audit trail is append-only.
CREATE FUNCTION zaka_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_append_only" BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION zaka_audit_append_only();
