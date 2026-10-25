/**
 * Application error with a stable machine code. Route handlers turn these into
 * `{ error: { code, message, details } }` responses; nothing else leaks to clients.
 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORISED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "LINK_INVALID"
  | "LINK_EXPIRED"
  | "PAYMENT_CLOSED"
  | "STALE_VERSION"
  | "LOCKED"
  | "INVALID_ALLOCATION"
  | "UNSUPPORTED_CURRENCY"
  | "WRONG_MODE"
  | "INVALID_STATE"
  | "SESSION_EXPIRED"
  | "ORDER_ALREADY_PAID"
  | "PAYMENT_IN_PROGRESS"
  | "OUT_OF_SEQUENCE"
  | "PROVIDER_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "SIGNATURE_INVALID"
  | "CONTEXT_MISMATCH"
  | "NOT_AVAILABLE"
  | "REPLAYED"
  | "RATE_LIMITED";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORISED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  LINK_INVALID: 401,
  LINK_EXPIRED: 410,
  PAYMENT_CLOSED: 409,
  STALE_VERSION: 409,
  LOCKED: 409,
  INVALID_ALLOCATION: 422,
  UNSUPPORTED_CURRENCY: 422,
  WRONG_MODE: 409,
  INVALID_STATE: 409,
  SESSION_EXPIRED: 410,
  ORDER_ALREADY_PAID: 409,
  PAYMENT_IN_PROGRESS: 409,
  OUT_OF_SEQUENCE: 409,
  PROVIDER_ERROR: 502,
  PROVIDER_UNAVAILABLE: 503,
  SIGNATURE_INVALID: 400,
  CONTEXT_MISMATCH: 400,
  NOT_AVAILABLE: 404,
  REPLAYED: 409,
  RATE_LIMITED: 429,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
