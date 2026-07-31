import * as Crypto from "expo-crypto";

import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

export type FriendSummary =
  Database["public"]["Functions"]["list_friends"]["Returns"][number];
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

export async function listFriends() {
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
