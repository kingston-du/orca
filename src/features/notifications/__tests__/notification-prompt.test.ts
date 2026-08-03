import {
  dismissNotificationPrompt,
  markNotificationPromptEarned,
  readNotificationPromptState,
  shouldShowPrePrompt,
} from "@/features/notifications/notification-prompt";
import { authStorage } from "@/lib/auth-storage";

jest.mock("@/lib/supabase", () => ({
  supabaseUrl: "https://example.test",
}));

jest.mock("@/lib/auth-storage", () => {
  const store = new Map<string, string>();
  return {
    authStorage: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      removeItem: jest.fn(async (key: string) => void store.delete(key)),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    },
    __store: store,
  };
});

const USER = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  const mocked = jest.requireMock("@/lib/auth-storage") as {
    __store: Map<string, string>;
  };
  mocked.__store.clear();
  jest.clearAllMocks();
});

describe("earning the right to ask", () => {
  it("starts unearned, so nothing prompts on a fresh install", async () => {
    expect(await readNotificationPromptState(USER)).toBe("not_earned");
  });

  it("is earned once and stays earned", async () => {
    await markNotificationPromptEarned(USER);
    await markNotificationPromptEarned(USER);
    expect(await readNotificationPromptState(USER)).toBe("earned");
    expect(authStorage.setItem).toHaveBeenCalledTimes(1);
  });

  it("never downgrades a dismissal back to earned", async () => {
    await dismissNotificationPrompt(USER);
    await markNotificationPromptEarned(USER);
    expect(await readNotificationPromptState(USER)).toBe("dismissed");
  });

  it("scopes the flag to the account and the environment", async () => {
    await markNotificationPromptEarned(USER);
    const [key] = (authStorage.setItem as jest.Mock).mock.calls[0];
    expect(key).toBe(`orca.push.prompt.https://example.test.${USER}`);
    expect(
      await readNotificationPromptState("22222222-2222-4222-8222-222222222222"),
    ).toBe("not_earned");
  });
});

describe("when the pre-prompt may appear", () => {
  it("appears only once value has been experienced and iOS has not answered", () => {
    expect(
      shouldShowPrePrompt({
        permission: "not_requested",
        promptState: "earned",
      }),
    ).toBe(true);
  });

  it.each(["granted", "denied", "provisional"])(
    "never appears once iOS has answered %s",
    (permission) => {
      // The system prompt is spent. A pre-prompt here would be a dialog that
      // cannot lead anywhere.
      expect(shouldShowPrePrompt({ permission, promptState: "earned" })).toBe(
        false,
      );
    },
  );

  it.each(["not_earned", "dismissed"] as const)(
    "never appears while the prompt is %s",
    (promptState) => {
      expect(
        shouldShowPrePrompt({ permission: "not_requested", promptState }),
      ).toBe(false);
    },
  );
});
