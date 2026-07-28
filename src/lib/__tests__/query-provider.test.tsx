import { render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";

import { createQueryClient } from "@/lib/query-client";
import { AppQueryProvider } from "@/lib/query-provider";

describe("AppQueryProvider", () => {
  test("does not clear user-scoped cache on the initial mount", async () => {
    const client = createQueryClient();
    client.setQueryData(["profile", "user-a"], { displayName: "Alice" });

    await render(
      <AppQueryProvider client={client} userId="user-a">
        <Text>App</Text>
      </AppQueryProvider>,
    );

    expect(client.getQueryData(["profile", "user-a"])).toEqual({
      displayName: "Alice",
    });

    client.clear();
  });

  test("does not clear user-scoped cache when the same user rerenders", async () => {
    const client = createQueryClient();
    client.setQueryData(["profile", "user-a"], { displayName: "Alice" });

    const screen = await render(
      <AppQueryProvider client={client} userId="user-a">
        <Text>App</Text>
      </AppQueryProvider>,
    );

    screen.rerender(
      <AppQueryProvider client={client} userId="user-a">
        <Text>App</Text>
      </AppQueryProvider>,
    );

    expect(client.getQueryData(["profile", "user-a"])).toEqual({
      displayName: "Alice",
    });

    client.clear();
  });

  test("clears user-scoped cache when a signed-in user signs out", async () => {
    const client = createQueryClient();
    client.setQueryData(["profile", "user-a"], { displayName: "Alice" });

    const screen = await render(
      <AppQueryProvider client={client} userId="user-a">
        <Text>App</Text>
      </AppQueryProvider>,
    );

    screen.rerender(
      <AppQueryProvider client={client} userId={null}>
        <Text>App</Text>
      </AppQueryProvider>,
    );

    await waitFor(() => {
      expect(client.getQueryData(["profile", "user-a"])).toBeUndefined();
    });
  });

  test("clears user-scoped cache when the authenticated user changes", async () => {
    const client = createQueryClient();
    client.setQueryData(["profile", "user-a"], { displayName: "Alice" });

    const screen = await render(
      <AppQueryProvider client={client} userId="user-a">
        <Text>App</Text>
      </AppQueryProvider>,
    );

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
