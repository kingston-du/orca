import { render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";

import { createQueryClient } from "@/lib/query-client";
import { AppQueryProvider } from "@/lib/query-provider";

describe("AppQueryProvider", () => {
  test("clears user-scoped cache when the authenticated identity changes", async () => {
    const client = createQueryClient();
    client.setQueryData(["profile", "user-a"], { displayName: "Alice" });

    const screen = await render(
      <AppQueryProvider client={client} userId="user-a">
        <Text>App</Text>
      </AppQueryProvider>,
    );

    expect(client.getQueryData(["profile", "user-a"])).toEqual({
      displayName: "Alice",
    });

    screen.rerender(
      <AppQueryProvider client={client} userId="user-b">
        <Text>App</Text>
      </AppQueryProvider>,
    );

    await waitFor(() => {
      expect(client.getQueryData(["profile", "user-a"])).toBeUndefined();
    });
  });
});
