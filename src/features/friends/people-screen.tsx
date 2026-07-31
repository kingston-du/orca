import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  listFriendRequests,
  listFriends,
  lookupProfileExact,
  runFriendOperation,
  type ProfileLookup,
} from "./friends-api";

const friendsKey = ["friends"] as const;
const requestsKey = ["friend-requests"] as const;

type PeopleScreenProps = {
  onOpenMyProfile: () => void;
  onOpenProfile: (profileId: string) => void;
};

export function PeopleScreen({
  onOpenMyProfile,
  onOpenProfile,
}: PeopleScreenProps) {
  const queryClient = useQueryClient();
  const friends = useQuery({ queryKey: friendsKey, queryFn: listFriends });
  const requests = useQuery({
    queryKey: requestsKey,
    queryFn: listFriendRequests,
  });
  const [username, setUsername] = useState("");
  const [lookup, setLookup] = useState<ProfileLookup | null>(null);
  const [lookupMessage, setLookupMessage] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const command = useMutation({
    mutationFn: async ({
      operation,
      otherId,
      expectedId,
    }: {
      operation: Parameters<typeof runFriendOperation>[0];
      otherId: string;
      expectedId?: string;
    }) => runFriendOperation(operation, otherId, expectedId),
    onError: () => setLookupMessage("That changed. Refresh and try again."),
    onSuccess: async () => {
      setLookup(null);
      setLookupMessage(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: friendsKey }),
        queryClient.invalidateQueries({ queryKey: requestsKey }),
      ]);
    },
  });

  async function search() {
    if (!/^[a-z][a-z0-9_]{2,19}$/.test(username.trim().toLowerCase())) {
      setLookup(null);
      setLookupMessage("Enter an exact Orca username.");
      return;
    }

    setIsSearching(true);
    setLookupMessage(null);
    try {
      const result = await lookupProfileExact(username);
      setLookup(result);
      if (!result)
        setLookupMessage("No available account matches that username.");
    } catch {
      setLookup(null);
      setLookupMessage("Search is unavailable. Try again.");
    } finally {
      setIsSearching(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          People
        </Text>

        <Pressable
          accessibilityRole="button"
          onPress={onOpenMyProfile}
          style={styles.profileCard}
        >
          <View style={styles.avatarPlaceholder}>
            <Text style={styles.avatarText}>Me</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.cardTitle}>My Profile</Text>
            <Text style={styles.body}>
              Identity, Settings, and your account
            </Text>
          </View>
          <Text accessibilityElementsHidden style={styles.chevron}>
            ›
          </Text>
        </Pressable>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Add Friend</Text>
          <Text style={styles.body}>Search by exact username.</Text>
          <View style={styles.searchRow}>
            <TextInput
              accessibilityLabel="Exact username"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(value) => {
                setUsername(value.toLowerCase());
                setLookup(null);
                setLookupMessage(null);
              }}
              placeholder="username"
              placeholderTextColor="#7B8794"
              style={styles.input}
              value={username}
            />
            <Pressable
              accessibilityRole="button"
              disabled={isSearching}
              onPress={() => void search()}
              style={styles.primaryButton}
            >
              {isSearching ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryLabel}>Search</Text>
              )}
            </Pressable>
          </View>
          {lookupMessage ? (
            <Text accessibilityLiveRegion="polite" style={styles.message}>
              {lookupMessage}
            </Text>
          ) : null}
          {lookup ? (
            <PersonRow
              action={lookupAction(lookup.relationship_state)}
              disabled={command.isPending}
              displayName={lookup.display_name}
              onAction={() => {
                const operation = lookupOperation(lookup.relationship_state);
                if (operation) {
                  command.mutate({
                    operation,
                    otherId: lookup.id,
                    expectedId: lookupExpectedId(lookup) ?? undefined,
                  });
                }
              }}
              username={lookup.username}
            />
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Requests</Text>
          {requests.isPending ? <ActivityIndicator /> : null}
          {requests.isError ? (
            <Retry onRetry={() => void requests.refetch()} />
          ) : null}
          {requests.data?.length === 0 ? (
            <Text style={styles.body}>No pending requests.</Text>
          ) : null}
          {requests.data?.map((request) => (
            <PersonRow
              action={request.direction === "incoming" ? "Accept" : "Cancel"}
              disabled={command.isPending}
              displayName={request.display_name}
              key={request.request_id}
              onAction={() =>
                command.mutate({
                  operation:
                    request.direction === "incoming"
                      ? "accept_friend_request"
                      : "cancel_friend_request",
                  otherId: request.id,
                  expectedId: request.request_id,
                })
              }
              secondaryAction={
                request.direction === "incoming" ? "Reject" : undefined
              }
              onSecondaryAction={() =>
                command.mutate({
                  operation: "reject_friend_request",
                  otherId: request.id,
                  expectedId: request.request_id,
                })
              }
              username={request.username}
            />
          ))}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Friends</Text>
          {friends.isPending ? <ActivityIndicator /> : null}
          {friends.isError ? (
            <Retry onRetry={() => void friends.refetch()} />
          ) : null}
          {friends.data?.length === 0 ? (
            <Text style={styles.body}>
              Add a friend to begin sharing Moments.
            </Text>
          ) : null}
          {friends.data?.map((friend) => (
            <PersonRow
              action="Unfriend"
              disabled={command.isPending}
              displayName={friend.display_name}
              key={friend.id}
              onAction={() =>
                command.mutate({
                  operation: "unfriend",
                  otherId: friend.id,
                  expectedId: friend.generation_id,
                })
              }
              onOpen={() => onOpenProfile(friend.id)}
              username={friend.username}
            />
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function lookupAction(state: string) {
  if (state === "none") return "Add";
  if (state === "incoming") return "Accept";
  if (state === "outgoing") return "Cancel";
  return undefined;
}

function lookupOperation(state: string) {
  if (state === "none") return "send_friend_request" as const;
  if (state === "incoming") return "accept_friend_request" as const;
  if (state === "outgoing") return "cancel_friend_request" as const;
  return null;
}

function lookupExpectedId(lookup: ProfileLookup) {
  if (
    lookup.relationship_state === "incoming" ||
    lookup.relationship_state === "outgoing"
  ) {
    return lookup.request_id;
  }
  if (lookup.relationship_state === "accepted") return lookup.generation_id;
  return undefined;
}

function PersonRow({
  action,
  disabled,
  displayName,
  onAction,
  onOpen,
  onSecondaryAction,
  secondaryAction,
  username,
}: {
  action?: string;
  disabled: boolean;
  displayName: string;
  onAction: () => void;
  onOpen?: () => void;
  onSecondaryAction?: () => void;
  secondaryAction?: string;
  username: string;
}) {
  // Only rows that lead somewhere become a button; a lookup result or pending
  // request row stays plain so VoiceOver does not announce a dead control.
  const Identity = onOpen ? Pressable : View;

  return (
    <View style={styles.personRow}>
      <Identity
        accessibilityHint={onOpen ? "Opens this profile" : undefined}
        accessibilityRole={onOpen ? "button" : undefined}
        onPress={onOpen}
        style={styles.flex}
      >
        <Text style={styles.cardTitle}>{displayName}</Text>
        <Text style={styles.body}>@{username}</Text>
      </Identity>
      {secondaryAction ? (
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={onSecondaryAction}
          style={styles.textButton}
        >
          <Text style={styles.textButtonLabel}>{secondaryAction}</Text>
        </Pressable>
      ) : null}
      {action ? (
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={onAction}
          style={styles.smallButton}
        >
          <Text style={styles.smallButtonLabel}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Retry({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.retryRow}>
      <Text style={styles.message}>Couldn’t load this section.</Text>
      <Pressable accessibilityRole="button" onPress={onRetry}>
        <Text style={styles.link}>Try again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  avatarPlaceholder: {
    alignItems: "center",
    backgroundColor: "#DCEEFB",
    borderRadius: 24,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  avatarText: { color: "#1769AA", fontWeight: "800" },
  body: { color: "#52606D", fontSize: 14, lineHeight: 20 },
  cardTitle: { color: "#102A43", fontSize: 16, fontWeight: "800" },
  chevron: { color: "#52606D", fontSize: 32 },
  content: { gap: 24, padding: 20, paddingBottom: 48 },
  flex: { flex: 1, gap: 2 },
  input: {
    backgroundColor: "#FFFFFF",
    borderColor: "#BCCCDC",
    borderRadius: 12,
    borderWidth: 1,
    color: "#102A43",
    flex: 1,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  link: { color: "#1769AA", fontWeight: "800" },
  message: { color: "#52606D", fontSize: 14 },
  personRow: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    flexDirection: "row",
    gap: 8,
    minHeight: 64,
    padding: 12,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 48,
    minWidth: 84,
    paddingHorizontal: 16,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  profileCard: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    flexDirection: "row",
    gap: 14,
    minHeight: 76,
    padding: 14,
  },
  retryRow: { alignItems: "center", flexDirection: "row", gap: 12 },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  searchRow: { flexDirection: "row", gap: 10 },
  section: { gap: 12 },
  sectionTitle: { color: "#102A43", fontSize: 20, fontWeight: "800" },
  smallButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 10,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 68,
    paddingHorizontal: 12,
  },
  smallButtonLabel: { color: "#FFFFFF", fontWeight: "800" },
  textButton: { justifyContent: "center", minHeight: 44, paddingHorizontal: 8 },
  textButtonLabel: { color: "#52606D", fontWeight: "700" },
  title: { color: "#102A43", fontSize: 34, fontWeight: "900" },
});
