import { render, userEvent } from "@testing-library/react-native";

import { LEGAL_DOCUMENT } from "@/features/legal/legal-documents";
import { LegalScreen } from "@/features/legal/legal-screen";

describe("LegalScreen", () => {
  test("draws the agreement from the bundled text, with no network read", async () => {
    const screen = await render(<LegalScreen onBack={jest.fn()} />);

    expect(screen.getByText(LEGAL_DOCUMENT.title)).toBeOnTheScreen();
    expect(screen.getByText("Version beta-2026-08-04")).toBeOnTheScreen();

    // The sections a reviewer and a user each need to be able to find.
    expect(screen.getByText("1. You must be 18 or older")).toBeOnTheScreen();
    expect(screen.getByText("8. Privacy Notice")).toBeOnTheScreen();
    expect(screen.getByText("10. Governing law")).toBeOnTheScreen();
  });

  test("shows prose rather than Markdown authoring marks", async () => {
    const screen = await render(<LegalScreen onBack={jest.fn()} />);

    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  test("can be dismissed", async () => {
    const onBack = jest.fn();
    const user = userEvent.setup();
    const screen = await render(<LegalScreen onBack={onBack} />);

    await user.press(screen.getByLabelText("Back"));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
