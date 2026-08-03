import { authStorage } from "@/lib/auth-storage";

import {
  clearPendingAccountDeletion,
  preparePendingAccountDeletion,
  readPendingAccountDeletion,
  saveDeletionReceiptId,
} from "@/features/account-deletion/deletion-storage";

jest.mock("expo-crypto", () => {
  const actual = jest.requireActual("expo-crypto");
  return { ...actual, randomUUID: jest.fn(() => "command-1") };
});

jest.mock("@/lib/auth-storage", () => ({
  authStorage: {
    getItem: jest.fn(),
    removeItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

const environment = "https://dev.example.test";

describe("the encrypted pending deletion record", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(authStorage.getItem).mockResolvedValue(null);
  });

  test("persists the capability and command before any caller can use them", async () => {
    const pending = await preparePendingAccountDeletion("user-1", environment);

    expect(pending.capability).toHaveLength(43);
    expect(pending.userId).toBe("user-1");
    expect(authStorage.setItem).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(
      jest.mocked(authStorage.setItem).mock.calls[0][1],
    );
    expect(stored).toEqual(pending);
  });

  test("an exact retry reuses the same command and capability", async () => {
    const first = await preparePendingAccountDeletion("user-1", environment);
    jest.mocked(authStorage.getItem).mockResolvedValue(JSON.stringify(first));

    await expect(
      preparePendingAccountDeletion("user-1", environment),
    ).resolves.toEqual(first);
    expect(authStorage.setItem).toHaveBeenCalledTimes(1);
  });

  test("an account mismatch purges rather than exposing another account's receipt", async () => {
    const first = await preparePendingAccountDeletion("user-1", environment);
    jest.mocked(authStorage.getItem).mockResolvedValue(JSON.stringify(first));

    await expect(
      readPendingAccountDeletion(environment, "user-2"),
    ).resolves.toBeNull();
    expect(authStorage.removeItem).toHaveBeenCalled();
  });

  test("receipt decoration keeps the raw capability encrypted locally", async () => {
    const pending = await preparePendingAccountDeletion("user-1", environment);
    await saveDeletionReceiptId(pending, "receipt-1");

    const lastWrite = jest.mocked(authStorage.setItem).mock.calls.at(-1);
    expect(lastWrite).toBeDefined();
    const stored = JSON.parse(lastWrite?.[1] ?? "{}");
    expect(stored.receiptId).toBe("receipt-1");
    expect(stored.capability).toBe(pending.capability);
  });

  test("explicit dismissal removes the environment-bound record", async () => {
    await clearPendingAccountDeletion(environment);
    expect(authStorage.removeItem).toHaveBeenCalledWith(
      `orca.account-deletion.pending.${environment}`,
    );
  });
});
