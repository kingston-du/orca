import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  userEvent,
  waitFor,
} from "@testing-library/react-native";

import { submitReport } from "@/features/safety/report-api";
import { ReportScreen } from "@/features/safety/report-screen";

// Only the network half is mocked; the category list and the detail rules are
// the real ones, so a change to either is caught here.
jest.mock("@/features/safety/report-api", () => ({
  newReportCommandId: jest.fn(() => "33333333-3333-4333-8333-333333333333"),
  submitReport: jest.fn(),
}));

async function renderReport(
  overrides: Partial<Parameters<typeof ReportScreen>[0]> = {},
) {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  return await render(
    <QueryClientProvider client={client}>
      <ReportScreen
        onDone={jest.fn()}
        subjectId="11111111-1111-4111-8111-111111111111"
        subjectKind="moment"
        subjectLabel="Alice"
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

function receipt(overrides = {}) {
  return {
    already_submitted: false,
    blocked_subject: false,
    evidence_status: "pending",
    report_id: "22222222-2222-4222-8222-222222222222",
    submitted_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("ReportScreen", () => {
  beforeEach(() => jest.resetAllMocks());

  test("a category is required before anything can be sent", async () => {
    const screen = await renderReport();

    expect(screen.getByText("Send report")).toBeDisabled();

    await userEvent.press(screen.getByText("Harassment or bullying"));
    expect(screen.getByText("Send report")).toBeEnabled();
  });

  test("submits the chosen category and the optional block together", async () => {
    jest
      .mocked(submitReport)
      .mockResolvedValue(receipt({ blocked_subject: true }));
    const screen = await renderReport();

    await userEvent.press(screen.getByText("Child safety"));
    await userEvent.type(
      screen.getByLabelText("Extra details"),
      "It is a photo of a child",
    );
    // A Switch reports a value change rather than a press.
    fireEvent(
      screen.getByLabelText("Also block this person"),
      "valueChange",
      true,
    );
    await userEvent.press(screen.getByText("Send report"));

    await waitFor(() => expect(submitReport).toHaveBeenCalledTimes(1));
    expect(jest.mocked(submitReport).mock.calls[0][0]).toMatchObject({
      blockSubject: true,
      category: "child_safety",
      details: "It is a photo of a child",
      subjectId: "11111111-1111-4111-8111-111111111111",
      subjectKind: "moment",
    });
  });

  test("a retry after a failure reuses the same command id, so one case is opened", async () => {
    jest
      .mocked(submitReport)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(receipt());
    const screen = await renderReport();

    await userEvent.press(screen.getByText("Something else"));
    await userEvent.press(screen.getByText("Send report"));
    await waitFor(() =>
      expect(
        screen.getByText(
          "That didn’t send. Check your connection and try again.",
        ),
      ).toBeOnTheScreen(),
    );

    await userEvent.press(screen.getByText("Send report"));
    await waitFor(() => expect(submitReport).toHaveBeenCalledTimes(2));

    const [first, second] = jest.mocked(submitReport).mock.calls;
    expect(second[0].commandId).toBe(first[0].commandId);
  });

  test("a rate-limited reporter is told what to do instead of a generic failure", async () => {
    jest
      .mocked(submitReport)
      .mockRejectedValue(
        Object.assign(new Error("limited"), { code: "P0001" }),
      );
    const screen = await renderReport();

    await userEvent.press(screen.getByText("Something else"));
    await userEvent.press(screen.getByText("Send report"));

    await waitFor(() =>
      expect(
        screen.getByText(
          "You have sent a lot of reports today. Try again later, or contact support.",
        ),
      ).toBeOnTheScreen(),
    );
  });

  test("the receipt promises an evidence copy only when the server made one", async () => {
    jest.mocked(submitReport).mockResolvedValue(receipt());
    const screen = await renderReport();

    await userEvent.press(screen.getByText("Something else"));
    await userEvent.press(screen.getByText("Send report"));

    await waitFor(() =>
      expect(screen.getByText("Report sent")).toBeOnTheScreen(),
    );
    expect(
      screen.getByText(
        "Orca is keeping a copy of the photo for the review, so it can still be checked if it is deleted.",
      ),
    ).toBeOnTheScreen();
  });

  test("and says so honestly when the photo could not be copied", async () => {
    jest
      .mocked(submitReport)
      .mockResolvedValue(receipt({ evidence_status: "unavailable" }));
    const screen = await renderReport();

    await userEvent.press(screen.getByText("Something else"));
    await userEvent.press(screen.getByText("Send report"));

    await waitFor(() =>
      expect(screen.getByText("Report sent")).toBeOnTheScreen(),
    );
    expect(
      screen.getByText(
        "The photo was no longer available to copy, so the review will use what you have told us.",
      ),
    ).toBeOnTheScreen();
  });

  test("the receipt never claims what will happen to the other account", async () => {
    jest.mocked(submitReport).mockResolvedValue(receipt());
    const screen = await renderReport();

    await userEvent.press(screen.getByText("Something else"));
    await userEvent.press(screen.getByText("Send report"));

    await waitFor(() =>
      expect(screen.getByText("Report sent")).toBeOnTheScreen(),
    );
    expect(screen.queryByText(/removed|suspended|banned/i)).toBeNull();
  });
});
