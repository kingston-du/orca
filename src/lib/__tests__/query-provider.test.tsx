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

  test("clears the outgoing identity before the incoming one can query", async () => {
    // The regression this pins: clearing in an effect runs *after* child
    // effects, so a child that queries on mount had its in-flight query
    // removed from the cache and its observer left permanently pending — a
    // loading screen with no error and no retry.
    const client = createQueryClient();
    let queryStateWhenChildMounted: unknown = "child never mounted";

    function ChildThatQueriesOnMount() {
      // Reading during render is what a child's `useQuery` effectively does
      // before the parent's effects have had a chance to run.
      queryStateWhenChildMounted = client.getQueryData(["profile", "user-a"]);
      return <Text>App</Text>;
    }

    client.setQueryData(["profile", "user-a"], { displayName: "Alice" });

    const screen = await render(
      <AppQueryProvider client={client} userId="user-a">
        <Text>App</Text>
      </AppQueryProvider>,
    );

    await screen.rerender(
      <AppQueryProvider client={client} userId="user-b">
        <ChildThatQueriesOnMount />
      </AppQueryProvider>,
    );

    expect(queryStateWhenChildMounted).toBeUndefined();
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
