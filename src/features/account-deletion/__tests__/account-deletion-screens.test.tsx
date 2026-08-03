import { render, userEvent, waitFor } from "@testing-library/react-native";

import { DeleteAccountScreen } from "@/features/account-deletion/delete-account-screen";
import { DeletionStatusScreen } from "@/features/account-deletion/deletion-status-screen";

describe("account deletion screens", () => {
  test("requires an explicit word before the destructive request", async () => {
    const onRequestDeletion = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const screen = await render(
      <DeleteAccountScreen
        onBack={jest.fn()}
        onOpenStatus={jest.fn()}
        onRequestDeletion={onRequestDeletion}
      />,
    );
    const button = screen.getByRole("button", { name: "Delete my account" });
    expect(button).toBeDisabled();

    await user.type(
      screen.getByLabelText("Type DELETE to confirm account deletion"),
      "DELETE",
    );
    expect(button).not.toBeDisabled();
    await user.press(button);
    expect(onRequestDeletion).toHaveBeenCalledTimes(1);
  });

  test("a lost response offers status rather than claiming failure", async () => {
    const onOpenStatus = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <DeleteAccountScreen
        onBack={jest.fn()}
        onOpenStatus={onOpenStatus}
        onRequestDeletion={jest.fn().mockRejectedValue(new Error("private"))}
      />,
    );
    await user.type(
      screen.getByLabelText("Type DELETE to confirm account deletion"),
      "DELETE",
    );
    await user.press(screen.getByText("Delete my account"));

    await waitFor(() =>
      expect(screen.getByText(/may still have started/i)).toBeOnTheScreen(),
    );
    expect(screen.queryByText("private")).toBeNull();
    await user.press(screen.getByText("Check deletion status"));
    expect(onOpenStatus).toHaveBeenCalledTimes(1);
  });

  test("a complete receipt is coarse, referenceable, and dismissible", async () => {
    const onDismiss = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <DeletionStatusScreen
        error={false}
        isLoading={false}
        onDismiss={onDismiss}
        onRetry={jest.fn()}
        status={{
          completed_at: "2026-08-02T00:01:00.000Z",
          error_code: null,
          receipt_id: "receipt-1",
          requested_at: "2026-08-02T00:00:00.000Z",
          status: "complete",
        }}
      />,
    );

    expect(screen.getByText("receipt-1")).toBeOnTheScreen();
    expect(screen.queryByText(/email|username|photo/i)).toBeNull();
    await user.press(screen.getByText("Done"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
