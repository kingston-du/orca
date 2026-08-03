import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

import { digestDeletionCapability } from "./deletion-capability";
import type { PendingAccountDeletion } from "./deletion-storage";

type GeneratedAccountDeletionStatus =
  Database["public"]["Functions"]["get_deletion_receipt"]["Returns"][number];

// PostgreSQL `returns table` nullability is not represented by generated
// Supabase types. These two columns are genuinely null before completion or
// when no terminal error exists.
export type AccountDeletionStatus = Omit<
  GeneratedAccountDeletionStatus,
  "completed_at" | "error_code"
> & {
  completed_at: string | null;
  error_code: string | null;
};

export async function requestAccountDeletion(pending: PendingAccountDeletion) {
  const capabilityDigest = await digestDeletionCapability(pending.capability);
  const { data, error } = await supabase.rpc("request_account_deletion", {
    p_capability_sha256: capabilityDigest,
    p_command_id: pending.commandId,
  });
  if (error) throw error;
  const row = data[0];
  if (!row) throw new Error("Deletion request unavailable");
  return row;
}

export async function loadDeletionReceipt(
  pending: PendingAccountDeletion,
): Promise<AccountDeletionStatus | null> {
  const capabilityDigest = await digestDeletionCapability(pending.capability);
  const { data, error } = await supabase.rpc("get_deletion_receipt", {
    p_capability_sha256: capabilityDigest,
  });
  if (error) throw error;
  return data[0] ?? null;
}

export async function loadAuthenticatedDeletionStatus(): Promise<AccountDeletionStatus | null> {
  const { data, error } = await supabase.rpc("get_account_deletion_status");
  if (error) throw error;
  return data[0] ?? null;
}
