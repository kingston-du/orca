import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { EmptyState } from "@/components/empty-state";
import { Icon } from "@/components/icon";
import { ProfileAvatar } from "@/components/profile-avatar";
import { ScreenHeader } from "@/components/screen-header";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import { useAuth } from "@/features/auth/auth-provider";
import {
  AddFriendSheet,
  lookupAction,
} from "@/features/friends/add-friend-sheet";
import { markNotificationPromptEarned } from "@/features/notifications/notification-prompt";

import {
  listFriendRequests,
  listFriends,
  runFriendOperation,
  type ProfileLookup,
} from "./friends-api";

const friendsKey = ["friends"] as const;
const requestsKey = ["friend-requests"] as const;

/** Three across, as the design draws it. */
const GRID_COLUMNS = 3;
const GRID_AVATAR = 82;

type PeopleScreenProps = {
  ownAvatarPath: string | null;
  ownDisplayName: string;
  onOpenInviteLink: () => void;
  onOpenMyProfile: () => void;
  onOpenProfile: (profileId: string) => void;
};

/**
 * People: your friends, as faces.
 *
 * The screen is the friend list and nothing else. Requests and search — both
 * previously permanent sections here — live behind the add-friend control in
 * the header, because the first thing the tab shows should be the people it is
 * named after rather than a queue of administration.
 *
 * The header's leading avatar is the app's only route to My Profile, and
 * therefore to Settings. That is deliberate: the design gives Home no header at
 * all, so this is where "you" has to live.
 */
export function PeopleScreen({
  onOpenInviteLink,
  onOpenMyProfile,
  onOpenProfile,
  ownAvatarPath,
  ownDisplayName,
}: PeopleScreenProps) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const friends = useQuery({ queryKey: friendsKey, queryFn: listFriends });
  const requests = useQuery({
    queryKey: requestsKey,
    queryFn: listFriendRequests,
  });

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
    onSuccess: async (_result, variables) => {
      // One of the two moments that earn the notification pre-prompt. Having a
      // friend is what makes "tell me when they share" a question somebody can
      // answer; asking before that spends iOS's single prompt on nothing.
      if (variables.operation === "accept_friend_request" && user?.id) {
        void markNotificationPromptEarned(user.id);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: friendsKey }),
        queryClient.invalidateQueries({ queryKey: requestsKey }),
      ]);
    },
  });

  // Only inbound requests are something for the viewer to answer, so only they
  // earn a badge. An outbound request is the viewer's own waiting.
  const incomingCount =
    requests.data?.filter((request) => request.direction === "incoming")
      .length ?? 0;

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScreenHeader
        leading={
          <Pressable
            accessibilityHint="Opens your profile and settings"
            accessibilityLabel="Your profile"
            accessibilityRole="button"
            onPress={onOpenMyProfile}
            style={({ pressed }) => (pressed ? styles.dim : null)}
            testID="people-my-profile"
          >
            <ProfileAvatar
              avatarPath={ownAvatarPath}
              displayName={ownDisplayName}
              size={32}
            />
          </Pressable>
        }
        title="People"
        trailing={
          <Pressable
            accessibilityHint="Friend requests and search"
            accessibilityLabel={
              incomingCount > 0
                ? `Add friends, ${incomingCount} pending ${incomingCount === 1 ? "request" : "requests"}`
                : "Add friends"
            }
            accessibilityRole="button"
            hitSlop={spacing.sm}
            onPress={() => setAddOpen(true)}
            style={({ pressed }) => [
              styles.addButton,
              pressed ? styles.dim : null,
            ]}
            testID="people-add-friend"
          >
            <Icon name="addFriend" size={24} />
            {/* The count is also in the button's accessible name above, so the
             * badge is a second carrier of the same fact rather than the only
             * one. */}
            {incomingCount > 0 ? (
              <View accessibilityElementsHidden style={styles.badge}>
                <Text style={styles.badgeLabel}>{incomingCount}</Text>
              </View>
            ) : null}
          </Pressable>
        }
      />

      {friends.isPending ? (
        <View style={styles.centered}>
          <ActivityIndicator accessibilityLabel="Loading friends" />
        </View>
      ) : friends.isError ? (
        <EmptyState
          action={
            <AppButton
              label="Try again"
              onPress={() => void friends.refetch()}
              variant="secondary"
            />
          }
          body="Your friends could not be loaded right now."
          title="Something went wrong"
        />
      ) : friends.data.length === 0 ? (
        <EmptyState
          action={
            <AppButton
              label="Add a friend"
              onPress={() => setAddOpen(true)}
              variant="secondary"
            />
          }
          body="Add a friend to begin sharing Moments."
          title="No friends yet"
        />
      ) : (
        <ScrollView contentContainerStyle={styles.grid}>
          {friends.data.map((friend) => (
            <Pressable
              accessibilityHint="Opens this profile"
              accessibilityLabel={`${friend.display_name}, @${friend.username}`}
              accessibilityRole="button"
              key={friend.id}
              onPress={() => onOpenProfile(friend.id)}
              style={({ pressed }) => [
                styles.cell,
                pressed ? styles.dim : null,
              ]}
            >
              <ProfileAvatar
                avatarPath={friend.avatar_path}
                displayName={friend.display_name}
                size={GRID_AVATAR}
              />
              <View style={styles.cellText}>
                <Text numberOfLines={1} style={styles.cellName}>
                  {friend.display_name}
                </Text>
                <Text numberOfLines={1} style={styles.cellHandle}>
                  @{friend.username}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <AddFriendSheet
        commandPending={command.isPending}
        onAcceptRequest={(request) =>
          command.mutate({
            operation: "accept_friend_request",
            otherId: request.id,
            expectedId: request.request_id,
          })
        }
        onCancelRequest={(request) =>
          command.mutate({
            operation: "cancel_friend_request",
            otherId: request.id,
            expectedId: request.request_id,
          })
        }
        onClose={() => setAddOpen(false)}
        onLookupAction={(lookup) => {
          const operation = lookupOperation(lookup.relationship_state);
          if (!operation || !lookupAction(lookup.relationship_state)) return;
          command.mutate({
            operation,
            otherId: lookup.id,
            expectedId: lookupExpectedId(lookup),
          });
        }}
        onOpenInviteLink={onOpenInviteLink}
        onRejectRequest={(request) =>
          command.mutate({
            operation: "reject_friend_request",
            otherId: request.id,
            expectedId: request.request_id,
          })
        }
        onRetryRequests={() => void requests.refetch()}
        requests={requests.data}
        requestsError={requests.isError}
        requestsPending={requests.isPending}
        visible={addOpen}
      />
    </SafeAreaView>
  );
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
    return lookup.request_id ?? undefined;
  }
  if (lookup.relationship_state === "accepted") {
    return lookup.generation_id ?? undefined;
  }
  return undefined;
}

const styles = StyleSheet.create({
  addButton: {
    alignItems: "center",
    height: MINIMUM_TOUCH_TARGET,
    justifyContent: "center",
    marginRight: -spacing.md,
    width: MINIMUM_TOUCH_TARGET,
  },
  badge: {
    alignItems: "center",
    backgroundColor: color.brand,
    borderRadius: radius.pill,
    height: 18,
    justifyContent: "center",
    minWidth: 18,
    paddingHorizontal: 4,
    position: "absolute",
    right: 2,
    top: 4,
  },
  badgeLabel: {
    ...typeScale.tabLabel,
    color: color.textInverse,
  },
  cell: {
    alignItems: "center",
    gap: spacing.sm,
    width: `${100 / GRID_COLUMNS}%`,
  },
  cellHandle: {
    ...typeScale.caption,
    color: color.textSecondary,
    textAlign: "center",
  },
  cellName: {
    ...typeScale.personName,
    color: color.textPrimary,
    textAlign: "center",
  },
  cellText: { alignItems: "center", gap: 2 },
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
  dim: { opacity: 0.6 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    rowGap: spacing.xxl,
  },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
});
