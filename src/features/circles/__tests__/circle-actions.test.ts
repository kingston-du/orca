import {
  createCircleActions,
  isValidInviteCode,
  normalizeInviteCode,
} from "@/features/circles/circle-actions";

const circle = {
  created_at: "2026-07-28T00:00:00Z",
  created_by: "11111111-1111-4111-8111-111111111111",
  id: "22222222-2222-4222-8222-222222222222",
  name: "Tuesday Crew",
  state: "active",
  updated_at: "2026-07-28T00:00:00Z",
};

function makeClient() {
  return {
    createCircle: jest.fn().mockResolvedValue({ data: circle, error: null }),
    createInvite: jest.fn().mockResolvedValue({ data: [], error: null }),
    leaveCircle: jest.fn().mockResolvedValue({ data: null, error: null }),
    previewInvite: jest.fn().mockResolvedValue({ data: [], error: null }),
    redeemInvite: jest.fn().mockResolvedValue({ data: [], error: null }),
    removeMember: jest.fn().mockResolvedValue({ data: null, error: null }),
    requestCircleDeletion: jest
      .fn()
      .mockResolvedValue({ data: [], error: null }),
    revokeInvite: jest.fn().mockResolvedValue({ data: null, error: null }),
    setMemberRole: jest.fn().mockResolvedValue({ data: null, error: null }),
  };
}

describe("Circle actions", () => {
  test("trims a Circle name before the trusted creation RPC", async () => {
    const client = makeClient();
    const actions = createCircleActions(client);

    await expect(actions.createCircle("  Tuesday Crew  ")).resolves.toEqual({
      kind: "success",
      value: circle,
    });
    expect(client.createCircle).toHaveBeenCalledWith({
      p_name: "Tuesday Crew",
    });
  });

  test("normalizes a pasted invite code and preserves idempotent redemption", async () => {
    const client = makeClient();
    const token = "a".repeat(64);
    client.redeemInvite.mockResolvedValue({
      data: [{ circle_id: circle.id, joined: false }],
      error: null,
    });
    const actions = createCircleActions(client);

    expect(normalizeInviteCode(`  ${token.toUpperCase()}  `)).toBe(token);
    expect(isValidInviteCode(token)).toBe(true);
    expect(isValidInviteCode("not-a-code")).toBe(false);
    await expect(
      actions.redeemInvite(` ${token.toUpperCase()} `),
    ).resolves.toEqual({
      kind: "success",
      value: { circleId: circle.id, joined: false },
    });
    expect(client.redeemInvite).toHaveBeenCalledWith({ p_token: token });
  });

  test("never calls the preview RPC for a malformed invite code", async () => {
    const client = makeClient();
    const actions = createCircleActions(client);

    await expect(actions.previewInvite("short")).resolves.toEqual({
      kind: "error",
      message: "Enter the 64-character invite code from your friend.",
    });
    expect(client.previewInvite).not.toHaveBeenCalled();
  });

  test("creates a default one-use invitation that expires in seven days", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const client = makeClient();
    client.createInvite.mockResolvedValue({
      data: [
        {
          circle_id: circle.id,
          expires_at: "2026-08-04T12:00:00.000Z",
          id: "33333333-3333-4333-8333-333333333333",
          max_uses: 1,
          token: "a".repeat(64),
        },
      ],
      error: null,
    });
    const actions = createCircleActions(client);

    await actions.createDefaultInvite(circle.id);

    expect(client.createInvite).toHaveBeenCalledWith({
      p_circle_id: circle.id,
      p_expires_at: "2026-08-04T12:00:00.000Z",
      p_max_uses: 1,
    });
    jest.useRealTimers();
  });
});
