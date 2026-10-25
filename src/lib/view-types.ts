import type { CurrencyCode } from "./currency";

/** Shape of GET /api/v1/session — role-scoped, safe to send to the viewer's browser. */

export type Mode = "STANDALONE" | "CONTRIBUTOR";
export type SessionStatus =
  | "OPEN"
  | "AWAITING_PAYMENT"
  | "CAPTURING"
  | "COMPLETED"
  | "CAPTURE_EXCEPTION"
  | "REVERSED"
  | "CANCELLED"
  | "EXPIRED"
  | "SUPERSEDED";

export type CardStatus =
  | "pending"
  | "awaiting_card"
  | "action_required"
  | "reserved"
  | "paid"
  | "declined"
  | "released"
  | "releasing"
  | "capture_failed"
  | "refunded";

export type PayerState =
  | "not_started"
  | "in_progress"
  | "reserved"
  | "paid"
  | "released"
  | "needs_retry"
  | "exception";

export interface CardView {
  position: number;
  amountMinor: number;
  status: CardStatus;
  brand: string | null;
  last4: string | null;
  message: string | null;
}

export interface AttemptView {
  id: string;
  attemptNumber: number;
  status: "IN_PROGRESS" | "AUTHORISED" | "CAPTURED" | "FAILED" | "RELEASED";
  cardCount: number;
  cards: CardView[];
}

export interface ParticipantView {
  id: string;
  role: "INITIATOR" | "CONTRIBUTOR" | "SHOPPER";
  name: string | null;
  obligationMinor: number;
  state: PayerState;
  isYou: boolean;
}

export interface FailureView {
  attemptNumber: number;
  position: number | null;
  message: string;
  releasedCards: { position: number; amountMinor: number; last4: string | null; released: boolean }[];
  /** The split that was tried, so the next attempt can start from it. */
  cardAmountsMinor: number[];
}

export interface SessionView {
  ref: string;
  orderRef: string;
  merchantName: string;
  description: string | null;
  returnUrl: string | null;
  mode: Mode | null;
  status: SessionStatus;
  terminalReason: string | null;
  totalMinor: number;
  currency: CurrencyCode;
  version: number;
  expiresAt: string;
  serverNow: string;
  viewer: { role: ParticipantView["role"]; canPay: boolean; canManage: boolean };
  you: ParticipantView & { attempt: AttemptView | null; lastFailure: FailureView | null };
  others: ParticipantView[];
  contributorLink: string | null;
  contributorEmailMasked: string | null;
  totals: { reservedMinor: number; paidMinor: number };
  provider: { kind: "stripe" | "simulated"; publishableKey: string | null; accountId: string | null } | null;
}
