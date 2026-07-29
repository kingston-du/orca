import { supabase } from "@/lib/supabase";

import { createCircleActions, type CircleInvite } from "./circle-actions";

export type CircleDetail = {
  circle: {
    id: string;
    name: string;
    state: string;
    created_at: string;
  };
  invites: CircleInvite[];
  members: { user_id: string; display_name: string; role: string }[];
};

export async function loadCircleHub() {
  const { data, error } = await supabase
    .from("circles")
    .select("id, name, state, created_at, updated_at")
    .eq("state", "active")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data;
}

export async function loadCircleDetail(
  circleId: string,
): Promise<CircleDetail> {
  const [circleResult, membersResult, invitesResult] = await Promise.all([
    supabase
      .from("circles")
      .select("id, name, state, created_at")
      .eq("id", circleId)
      .single(),
    supabase.rpc("list_circle_members", { p_circle_id: circleId }),
    supabase
      .from("circle_invites")
      .select(
        "id, circle_id, created_at, expires_at, max_uses, use_count, revoked_at",
      )
      .eq("circle_id", circleId)
      .order("created_at", { ascending: false }),
  ]);

  if (circleResult.error) {
    throw circleResult.error;
  }

  if (membersResult.error) {
    throw membersResult.error;
  }

  if (invitesResult.error) {
    throw invitesResult.error;
  }

  return {
    circle: circleResult.data,
    invites: invitesResult.data,
    members: membersResult.data,
  };
}

export const circleActions = createCircleActions({
  createCircle: (args) => supabase.rpc("create_circle", args),
  createInvite: (args) => supabase.rpc("create_circle_invite", args),
  leaveCircle: (args) => supabase.rpc("leave_circle", args),
  previewInvite: (args) => supabase.rpc("preview_circle_invite", args),
  redeemInvite: (args) => supabase.rpc("redeem_circle_invite", args),
  removeMember: (args) => supabase.rpc("remove_circle_member", args),
  requestCircleDeletion: (args) =>
    supabase.rpc("request_circle_deletion", args),
  revokeInvite: (args) => supabase.rpc("revoke_circle_invite", args),
  setMemberRole: (args) => supabase.rpc("set_circle_member_role", args),
});
