import * as Crypto from "expo-crypto";

import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

type GeneratedFriendSummary =
  Database["public"]["Functions"]["list_friends"]["Returns"][number];
// Generated RPC row types are non-nullable by default; a profile without a
// published avatar really does return null here.
export type FriendSummary = Omit<GeneratedFriendSummary, "avatar_path"> & {
  avatar_path: string | null;
};
export type FriendRequestSummary =
  Database["public"]["Functions"]["list_friend_requests"]["Returns"][number];
type GeneratedProfileLookup =
  Database["public"]["Functions"]["lookup_profile_exact"]["Returns"][number];
export type ProfileLookup = Omit<
  GeneratedProfileLookup,
  "generation_id" | "request_id" | "requester_id"
> & {
  generation_id: string | null;
  request_id: string | null;
  requester_id: string | null;
};
type GeneratedFriendCommandResult =
  Database["public"]["Functions"]["send_friend_request"]["Returns"][number];
export type FriendCommandResult = Omit<
  GeneratedFriendCommandResult,
  "generation_id" | "request_id"
> & {
  generation_id: string | null;
  request_id: string | null;
};

export async function listFriends(): Promise<FriendSummary[]> {
  const { data, error } = await supabase.rpc("list_friends", {
    p_after_id: undefined,
    p_after_username: undefined,
    p_limit: 50,
  });
  if (error) throw error;
  return data;
}

export async function listFriendRequests() {
  const { data, error } = await supabase.rpc("list_friend_requests", {
    p_before_request_id: undefined,
    p_before_requested_at: undefined,
    p_limit: 30,
  });
  if (error) throw error;
  return data;
}

export async function lookupProfileExact(
  username: string,
): Promise<ProfileLookup | null> {
  const { data, error } = await supabase.rpc("lookup_profile_exact", {
    p_username: username.trim().toLowerCase(),
  });
  if (error) throw error;
  return data[0] ?? null;
}

type FriendOperation =
  | "accept_friend_request"
  | "cancel_friend_request"
  | "reject_friend_request"
  | "send_friend_request"
  | "unfriend";

export async function runFriendOperation(
  operation: FriendOperation,
  otherId: string,
  expectedId?: string,
): Promise<FriendCommandResult> {
  const commandId = Crypto.randomUUID();
  const args =
    operation === "send_friend_request"
      ? { p_command_id: commandId, p_other_id: otherId }
      : operation === "unfriend"
        ? {
            p_command_id: commandId,
            p_generation_id: expectedId ?? "",
            p_other_id: otherId,
          }
        : {
            p_command_id: commandId,
            p_other_id: otherId,
            p_request_id: expectedId ?? "",
          };

  const { data, error } = await supabase.rpc(operation, args);
  if (error) throw error;
  return data[0];
}

type GeneratedProfileSummary =
  Database["public"]["Functions"]["get_profile_summary"]["Returns"][number];
// The stranger tier deliberately receives no avatar path at all.
export type ProfileSummary = Omit<GeneratedProfileSummary, "avatar_path"> & {
  avatar_path: string | null;
};
type GeneratedFriendOfFriend =
  Database["public"]["Functions"]["list_friend_friends"]["Returns"][number];
export type FriendOfFriend = Omit<GeneratedFriendOfFriend, "avatar_path"> & {
  avatar_path: string | null;
};
type GeneratedBlockedProfile =
  Database["public"]["Functions"]["list_blocked_profiles"]["Returns"][number];
// A suspended or deleting blocked account keeps its row so the block can still
// be lifted, but the server withholds its identity.
export type BlockedProfile = Omit<
  GeneratedBlockedProfile,
  "username" | "display_name"
> & { username: string | null; display_name: string | null };

/** Returns null when the subject is unavailable, blocked, or does not exist —
 * the server deliberately does not distinguish those cases. */
export async function getProfileSummary(
  profileId: string,
): Promise<ProfileSummary | null> {
  const { data, error } = await supabase.rpc("get_profile_summary", {
    p_profile_id: profileId,
  });
  if (error) throw error;
  return data[0] ?? null;
}

export async function listFriendFriends(
  friendId: string,
): Promise<FriendOfFriend[]> {
  const { data, error } = await supabase.rpc("list_friend_friends", {
    p_after_id: undefined,
    p_after_username: undefined,
    p_friend_id: friendId,
    p_limit: 50,
  });
  if (error) throw error;
  return data;
}

export async function listBlockedProfiles(): Promise<BlockedProfile[]> {
  const { data, error } = await supabase.rpc("list_blocked_profiles", {
    p_after_blocked_id: undefined,
    p_after_created_at: undefined,
    p_limit: 50,
  });
  if (error) throw error;
  return data;
}

export async function blockUser(otherId: string): Promise<FriendCommandResult> {
  const { data, error } = await supabase.rpc("block_user", {
    p_command_id: Crypto.randomUUID(),
    p_other_id: otherId,
  });
  if (error) throw error;
  return data[0];
}

export async function unblockUser(
  otherId: string,
  blockGenerationId: string,
): Promise<FriendCommandResult> {
  const { data, error } = await supabase.rpc("unblock_user", {
    p_block_generation_id: blockGenerationId,
    p_command_id: Crypto.randomUUID(),
    p_other_id: otherId,
  });
  if (error) throw error;
  return data[0];
}
