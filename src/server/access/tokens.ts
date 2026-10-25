import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ParticipantRole } from "@/generated/prisma/client";
import { config } from "../config";
import { db, type Tx } from "../db";
import { AppError } from "../errors";

/**
 * Payer capability links. A token is 256 random bits, shown to the user once inside a URL
 * fragment, and stored only as an HMAC (lookup) plus — for contributor links that the initiator
 * may need to re-share — an AES-256-GCM ciphertext.
 */

const PREFIX = "zk";

export function generateToken(): string {
  return PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHmac("sha256", Buffer.from(config().TOKEN_PEPPER, "base64")).update(token).digest("hex");
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config().TOKEN_ENCRYPTION_KEY, "base64"), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(sealed: string): string {
  const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(config().TOKEN_ENCRYPTION_KEY, "base64"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function payerLink(token: string): string {
  return `${config().APP_URL.replace(/\/$/, "")}/pay#${token}`;
}

const VIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssueTokenInput {
  sessionId: string;
  participantId: string;
  role: ParticipantRole;
  canManage: boolean;
  payExpiresAt: Date;
  keepEncryptedCopy?: boolean;
}

export async function issueToken(tx: Tx, input: IssueTokenInput): Promise<string> {
  const token = generateToken();
  await tx.accessToken.create({
    data: {
      sessionId: input.sessionId,
      participantId: input.participantId,
      role: input.role,
      tokenHash: hashToken(token),
      tokenEncrypted: input.keepEncryptedCopy ? encryptSecret(token) : null,
      canPay: true,
      canManage: input.canManage,
      payExpiresAt: input.payExpiresAt,
      viewExpiresAt: new Date(Date.now() + VIEW_TTL_MS),
    },
  });
  return token;
}

export interface Viewer {
  tokenId: string;
  sessionId: string;
  participantId: string;
  role: ParticipantRole;
  /** Token still grants payment actions (session state is checked separately). */
  payCapability: boolean;
  manageCapability: boolean;
}

const TOKEN_SHAPE = /^zk[A-Za-z0-9_-]{43}$/;

export function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * Resolve a raw token to a viewer. Unknown, malformed and revoked tokens all produce the same
 * LINK_INVALID response so that responses don't reveal which tokens exist.
 */
export async function resolveViewer(rawToken: string | null, now = new Date()): Promise<Viewer> {
  if (!rawToken || !TOKEN_SHAPE.test(rawToken)) {
    throw new AppError("LINK_INVALID", "This link isn't valid.");
  }
  const hash = hashToken(rawToken);
  const row = await db.accessToken.findUnique({ where: { tokenHash: hash } });
  if (!row || row.revokedAt || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(hash))) {
    throw new AppError("LINK_INVALID", "This link isn't valid.");
  }
  if (row.viewExpiresAt <= now) {
    throw new AppError("LINK_EXPIRED", "This link has expired.");
  }
  await db.accessToken.update({ where: { id: row.id }, data: { lastUsedAt: now } });
  const payOpen = row.canPay && !row.payRevokedAt && row.payExpiresAt > now;
  return {
    tokenId: row.id,
    sessionId: row.sessionId,
    participantId: row.participantId,
    role: row.role,
    payCapability: payOpen,
    manageCapability: payOpen && row.canManage,
  };
}

export function requirePay(viewer: Viewer) {
  if (!viewer.payCapability) {
    throw new AppError("PAYMENT_CLOSED", "Payment is no longer open on this link.");
  }
}

export function requireManage(viewer: Viewer) {
  requirePay(viewer);
  if (!viewer.manageCapability) {
    throw new AppError("FORBIDDEN", "Only the person who started this checkout can do that.");
  }
}

/** Remove payment/manage capability from every link of a session; view access remains. */
export async function revokePayCapability(tx: Tx, sessionId: string, at = new Date()) {
  await tx.accessToken.updateMany({
    where: { sessionId, payRevokedAt: null },
    data: { payRevokedAt: at },
  });
}

/** Fully revoke links (used when a session is superseded before anyone paid). */
export async function revokeAllAccess(tx: Tx, sessionId: string, at = new Date()) {
  await tx.accessToken.updateMany({
    where: { sessionId, revokedAt: null },
    data: { revokedAt: at, payRevokedAt: at },
  });
}
