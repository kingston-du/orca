import { requestAccountDeletion } from "@/features/account-deletion/account-deletion-api";
import { beginAccountDeletion } from "@/features/account-deletion/account-deletion-actions";
import {
  preparePendingAccountDeletion,
  saveDeletionReceiptId,
} from "@/features/account-deletion/deletion-storage";

jest.mock("@/features/account-deletion/account-deletion-api", () => ({
  requestAccountDeletion: jest.fn(),
}));
jest.mock("@/features/account-deletion/deletion-storage", () => ({
  preparePendingAccountDeletion: jest.fn(),
  saveDeletionReceiptId: jest.fn(),
}));

const pending = {
  capability: "a".repeat(43),
  commandId: "command-1",
  createdAt: "2026-08-02T00:00:00.000Z",
  environmentUrl: "https://dev.example.test",
  receiptId: null,
  userId: "user-1",
  version: 1 as const,
};

describe("beginAccountDeletion", () => {
  beforeEach(() => jest.resetAllMocks());

  test("persists before requesting and records the public receipt last", async () => {
    const order: string[] = [];
    jest.mocked(preparePendingAccountDeletion).mockImplementation(async () => {
      order.push("persist");
      return pending;
    });
    jest.mocked(requestAccountDeletion).mockImplementation(async () => {
      order.push("request");
      return {
        receipt_id: "receipt-1",
        requested_at: "2026-08-02T00:00:00.000Z",
        status: "requested",
      };
    });
    jest.mocked(saveDeletionReceiptId).mockImplementation(async (record) => {
      order.push("receipt");
      return { ...record, receiptId: "receipt-1" };
    });

    await beginAccountDeletion("user-1", "https://dev.example.test");
    expect(order).toEqual(["persist", "request", "receipt"]);
  });

  test("a lost response leaves the already-persisted capability available", async () => {
    jest.mocked(preparePendingAccountDeletion).mockResolvedValue(pending);
    jest.mocked(requestAccountDeletion).mockRejectedValue(new Error("lost"));

    await expect(
      beginAccountDeletion("user-1", "https://dev.example.test"),
    ).rejects.toThrow("lost");
    expect(saveDeletionReceiptId).not.toHaveBeenCalled();
  });
});
