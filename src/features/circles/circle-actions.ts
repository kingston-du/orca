import type { Database, Tables } from "@/types/database";

export type Circle = Tables<"circles">;
export type CircleMember =
  Database["public"]["Functions"]["list_circle_members"]["Returns"][number];
export type CircleInvite = Pick<
  Tables<"circle_invites">,
  | "id"
  | "circle_id"
  | "created_at"
  | "expires_at"
  | "max_uses"
  | "use_count"
  | "revoked_at"
>;
export type CreatedInvite =
  Database["public"]["Functions"]["create_circle_invite"]["Returns"][number];
export type InvitePreview =
  Database["public"]["Functions"]["preview_circle_invite"]["Returns"][number];

type RpcError = { code?: string; message: string } | null;

type RpcResult<T> = PromiseLike<{ data: T | null; error: RpcError }>;

type CircleRpcClient = {
  createCircle: (args: { p_name: string }) => RpcResult<Circle>;
  createInvite: (
    args: Database["public"]["Functions"]["create_circle_invite"]["Args"],
  ) => RpcResult<CreatedInvite[]>;
  leaveCircle: (
    args: Database["public"]["Functions"]["leave_circle"]["Args"],
  ) => RpcResult<undefined>;
  previewInvite: (
    args: Database["public"]["Functions"]["preview_circle_invite"]["Args"],
  ) => RpcResult<InvitePreview[]>;
  redeemInvite: (
    args: Database["public"]["Functions"]["redeem_circle_invite"]["Args"],
  ) => RpcResult<
    Database["public"]["Functions"]["redeem_circle_invite"]["Returns"]
  >;
  removeMember: (
    args: Database["public"]["Functions"]["remove_circle_member"]["Args"],
  ) => RpcResult<undefined>;
  requestCircleDeletion: (args: {
    p_circle_id: string;
  }) => RpcResult<{ circle_id: string; completed: boolean }[]>;
  revokeInvite: (
    args: Database["public"]["Functions"]["revoke_circle_invite"]["Args"],
  ) => RpcResult<undefined>;
  setMemberRole: (
    args: Database["public"]["Functions"]["set_circle_member_role"]["Args"],
  ) => RpcResult<
    Database["public"]["Functions"]["set_circle_member_role"]["Returns"]
  >;
};

export type CircleActionResult<T> =
  { kind: "success"; value: T } | { kind: "error"; message: string };

const INVITE_CODE_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeInviteCode(value: string) {
  return value.trim().toLowerCase();
}

export function isValidInviteCode(value: string) {
  return INVITE_CODE_PATTERN.test(value);
}

function safeErrorMessage(error: RpcError, fallback: string) {
  if (!error) {
    return fallback;
  }

  if (error.code === "23514") {
    return "A Circle needs at least one admin. Choose another admin first.";
  }

  if (error.code === "22023") {
    return fallback;
  }

  if (error.code === "42501") {
    return "You don’t have permission to make that change.";
  }

  return fallback;
}

function success<T>(value: T): CircleActionResult<T> {
  return { kind: "success", value };
}

function failure<T>(message: string): CircleActionResult<T> {
  return { kind: "error", message };
}

export function createCircleActions(client: CircleRpcClient) {
  async function createCircle(
    name: string,
  ): Promise<CircleActionResult<Circle>> {
    const trimmedName = name.trim();

    if (trimmedName.length < 1 || trimmedName.length > 50) {
      return failure("Give your Circle a name between 1 and 50 characters.");
    }

    const { data, error } = await client.createCircle({ p_name: trimmedName });

    if (error || !data) {
      return failure(
        safeErrorMessage(error, "We couldn’t create that Circle. Try again."),
      );
    }

    return success(data);
  }

  async function previewInvite(
    code: string,
  ): Promise<CircleActionResult<InvitePreview>> {
    const token = normalizeInviteCode(code);

    if (!isValidInviteCode(token)) {
      return failure("Enter the 64-character invite code from your friend.");
    }

    const { data, error } = await client.previewInvite({ p_token: token });
    const preview = data?.[0];

    if (error || !preview || !preview.is_usable) {
      return failure(
        "That invitation is invalid, expired, revoked, or already full.",
      );
    }

    return success(preview);
  }

  async function redeemInvite(code: string) {
    const token = normalizeInviteCode(code);

    if (!isValidInviteCode(token)) {
      return failure<{ circleId: string; joined: boolean }>(
        "Enter the 64-character invite code from your friend.",
      );
    }

    const { data, error } = await client.redeemInvite({ p_token: token });
    const redemption = data?.[0];

    if (error || !redemption) {
      return failure<{ circleId: string; joined: boolean }>(
        safeErrorMessage(
          error,
          "That invitation is invalid, expired, revoked, or already full.",
        ),
      );
    }

    return success({
      circleId: redemption.circle_id,
      joined: redemption.joined,
    });
  }

  async function createDefaultInvite(circleId: string) {
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data, error } = await client.createInvite({
      p_circle_id: circleId,
      p_expires_at: expiresAt,
      p_max_uses: 10,
    });
    const invite = data?.[0];

    if (error || !invite) {
      return failure<CreatedInvite>(
        safeErrorMessage(error, "We couldn’t create an invitation. Try again."),
      );
    }

    return success(invite);
  }

  async function revokeInvite(circleId: string, inviteId: string) {
    const { error } = await client.revokeInvite({
      p_circle_id: circleId,
      p_invite_id: inviteId,
    });

    return error
      ? failure<void>(
          safeErrorMessage(
            error,
            "We couldn’t revoke that invitation. Try again.",
          ),
        )
      : success(undefined);
  }

  async function setMemberRole(
    circleId: string,
    userId: string,
    role: "admin" | "member",
  ) {
    const { data, error } = await client.setMemberRole({
      p_circle_id: circleId,
      p_role: role,
      p_user_id: userId,
    });

    return error || !data
      ? failure<
          Database["public"]["Functions"]["set_circle_member_role"]["Returns"]
        >(safeErrorMessage(error, "We couldn’t update that member. Try again."))
      : success(data);
  }

  async function removeMember(circleId: string, userId: string) {
    const { error } = await client.removeMember({
      p_circle_id: circleId,
      p_user_id: userId,
    });

    return error
      ? failure<void>(
          safeErrorMessage(error, "We couldn’t remove that member. Try again."),
        )
      : success(undefined);
  }

  async function leaveCircle(circleId: string) {
    const { error } = await client.leaveCircle({ p_circle_id: circleId });

    return error
      ? failure<void>(
          safeErrorMessage(error, "We couldn’t leave this Circle. Try again."),
        )
      : success(undefined);
  }

  async function requestCircleDeletion(circleId: string) {
    const { data, error } = await client.requestCircleDeletion({
      p_circle_id: circleId,
    });
    const result = data?.[0];

    return error || !result
      ? failure<{ circleId: string; completed: boolean }>(
          safeErrorMessage(error, "We couldn’t delete this Circle. Try again."),
        )
      : success({ circleId: result.circle_id, completed: result.completed });
  }

  return {
    createCircle,
    createDefaultInvite,
    leaveCircle,
    previewInvite,
    redeemInvite,
    removeMember,
    requestCircleDeletion,
    revokeInvite,
    setMemberRole,
  };
}
