import * as Crypto from "expo-crypto";

import { authStorage } from "@/lib/auth-storage";

import {
  createDeletionCapability,
  isDeletionCapability,
} from "./deletion-capability";

const RECORD_VERSION = 1;
const MAX_LOCAL_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export type PendingAccountDeletion = {
  version: 1;
  environmentUrl: string;
  userId: string;
  commandId: string;
  capability: string;
  createdAt: string;
  receiptId: string | null;
};

function storageKeyFor(environmentUrl: string) {
  return `orca.account-deletion.pending.${environmentUrl}`;
}

function isPendingAccountDeletion(
  value: unknown,
): value is PendingAccountDeletion {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PendingAccountDeletion>;
  return (
    candidate.version === RECORD_VERSION &&
    typeof candidate.environmentUrl === "string" &&
    typeof candidate.userId === "string" &&
    typeof candidate.commandId === "string" &&
    typeof candidate.capability === "string" &&
    isDeletionCapability(candidate.capability) &&
    typeof candidate.createdAt === "string" &&
    (candidate.receiptId === null || typeof candidate.receiptId === "string")
  );
}

function hasExpired(record: PendingAccountDeletion) {
  const createdAt = Date.parse(record.createdAt);
  return (
    !Number.isFinite(createdAt) || Date.now() - createdAt >= MAX_LOCAL_AGE_MS
  );
}

/**
 * Creates and encrypts the recovery capability before the network request.
 * Re-entering the flow for the same account returns the exact same command,
 * which is what makes a lost response retry-safe.
 */
export async function preparePendingAccountDeletion(
  userId: string,
  environmentUrl: string,
) {
  const existing = await readPendingAccountDeletion(environmentUrl, userId);
  if (existing) return existing;

  const record: PendingAccountDeletion = {
    capability: createDeletionCapability(),
    commandId: Crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    environmentUrl,
    receiptId: null,
    userId,
    version: RECORD_VERSION,
  };
  await authStorage.setItem(
    storageKeyFor(environmentUrl),
    JSON.stringify(record),
  );
  return record;
}

export async function readPendingAccountDeletion(
  environmentUrl: string,
  expectedUserId?: string,
): Promise<PendingAccountDeletion | null> {
  const key = storageKeyFor(environmentUrl);
  const stored = await authStorage.getItem(key);
  if (!stored) return null;

  try {
    const parsed: unknown = JSON.parse(stored);
    if (
      !isPendingAccountDeletion(parsed) ||
      parsed.environmentUrl !== environmentUrl ||
      (expectedUserId !== undefined && parsed.userId !== expectedUserId) ||
      hasExpired(parsed)
    ) {
      await authStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    await authStorage.removeItem(key);
    return null;
  }
}

export async function saveDeletionReceiptId(
  record: PendingAccountDeletion,
  receiptId: string,
) {
  const next = { ...record, receiptId } satisfies PendingAccountDeletion;
  await authStorage.setItem(
    storageKeyFor(record.environmentUrl),
    JSON.stringify(next),
  );
  return next;
}

export async function clearPendingAccountDeletion(environmentUrl: string) {
  await authStorage.removeItem(storageKeyFor(environmentUrl));
}
