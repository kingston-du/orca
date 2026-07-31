import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

export type InviteStatus =
  Database["public"]["Functions"]["get_invite_status"]["Returns"][number];
export type InvitePreview =
  Database["public"]["Functions"]["resolve_invite"]["Returns"][number];

/** Returns null when the caller has no active link on the server. */
export async function getInviteStatus(): Promise<InviteStatus | null> {
  const { data, error } = await supabase.rpc("get_invite_status");
  if (error) throw error;
  return data[0] ?? null;
}

export async function createInviteLink(
  tokenSha256: string,
): Promise<InviteStatus> {
  const { data, error } = await supabase.rpc("create_invite_link", {
    p_token_sha256: tokenSha256,
  });
  if (error) throw error;
  return data[0];
}

export async function rotateInviteLink(
  tokenSha256: string,
): Promise<InviteStatus> {
  const { data, error } = await supabase.rpc("rotate_invite_link", {
    p_token_sha256: tokenSha256,
  });
  if (error) throw error;
  return data[0];
}

export async function revokeInviteLink() {
  const { error } = await supabase.rpc("revoke_invite_link");
  if (error) throw error;
}

/**
 * Returns null for unknown, expired, revoked, blocked, and unavailable links
 * alike — the server deliberately does not distinguish them, so a guessed token
 * reveals nothing.
 */
export async function resolveInvite(
  tokenSha256: string,
): Promise<InvitePreview | null> {
  const { data, error } = await supabase.rpc("resolve_invite", {
    p_token_sha256: tokenSha256,
  });
  if (error) throw error;
  return data[0] ?? null;
}
