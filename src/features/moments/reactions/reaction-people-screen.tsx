import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ProfileAvatar } from "@/components/profile-avatar";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import { useAuth } from "@/features/auth/auth-provider";
import {
  REACTION_PAGE_SIZE,
  listMomentReactions,
  type ReactionPerson,
} from "@/features/moments/reactions/reaction-api";

type Cursor = { reactedAt: string; userId: string } | null;

/**
 * Who reacted.
 *
 * Modest on purpose: names, in the order they reacted, and which of the two
 * reactions each person left. No totals per person, no ranking, no "top
 * reactor". The list is already filtered server-side, so what is missing from
 * it is not observable here — which is the point.
 */
export function ReactionPeopleScreen({ momentId }: { momentId: string }) {
  const { user } = useAuth();

  const people = useInfiniteQuery({
    queryKey: ["moment-reactions", user?.id, momentId],
    initialPageParam: null as Cursor,
    queryFn: ({ pageParam }) =>
      listMomentReactions({ momentId, cursor: pageParam }),
    getNextPageParam: (lastPage) => {
      const last = lastPage.at(-1);
      if (!last || lastPage.length < REACTION_PAGE_SIZE) return undefined;
      return { reactedAt: last.reacted_at, userId: last.user_id };
    },
  });

  const rows = useMemo<ReactionPerson[]>(
    () => people.data?.pages.flat() ?? [],
    [people.data],
  );

  if (people.isPending) {
    return (
      <SafeAreaView style={styles.centred}>
        <ActivityIndicator
          accessibilityLabel="Loading reactions"
          size="large"
        />
      </SafeAreaView>
    );
  }

  if (people.isError) {
    return (
      <SafeAreaView style={styles.centred}>
        <Text accessibilityRole="header" style={styles.title}>
          Couldn’t load reactions
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void people.refetch()}
          style={styles.action}
        >
          <Text style={styles.actionLabel}>Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (rows.length === 0) {
    return (
      <SafeAreaView style={styles.centred}>
        <Text accessibilityRole="header" style={styles.title}>
          No reactions yet
        </Text>
        <Text style={styles.body}>
          Hearts and Superhearts from your friends will show up here.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <FlatList
        contentContainerStyle={styles.list}
        data={rows}
        keyExtractor={(person) => person.user_id}
        onEndReached={() => {
          if (people.hasNextPage && !people.isFetchingNextPage) {
            void people.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        renderItem={({ item }) => <PersonRow person={item} />}
        testID="reaction-people"
      />
    </SafeAreaView>
  );
}

function PersonRow({ person }: { person: ReactionPerson }) {
  const reaction = person.reaction === "superheart" ? "Superheart" : "Heart";
  return (
    <View
      accessible
      accessibilityLabel={`${person.display_name}, @${person.username}, ${reaction}`}
      style={styles.row}
    >
      <ProfileAvatar
        avatarPath={person.avatar_path}
        displayName={person.display_name}
        size={40}
      />
      <View style={styles.names}>
        <Text numberOfLines={1} style={styles.displayName}>
          {person.display_name}
        </Text>
        <Text numberOfLines={1} style={styles.body}>
          @{person.username}
        </Text>
      </View>
      {/* Text, not a coloured dot: the difference between the two reactions must
       * never be carried by colour alone. */}
      <Text
        style={[
          styles.reaction,
          person.reaction === "superheart" && styles.reactionSuper,
        ]}
      >
        {reaction}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    backgroundColor: color.brandSurface,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  actionLabel: { ...typeScale.label, color: color.brand },
  body: { ...typeScale.caption, color: color.textSecondary },
  centred: {
    alignItems: "center",
    backgroundColor: color.canvas,
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.xl,
  },
  displayName: { ...typeScale.label, color: color.textPrimary },
  list: { gap: spacing.md, padding: spacing.lg },
  names: { flexShrink: 1, gap: 2 },
  reaction: { ...typeScale.caption, color: color.brand, marginLeft: "auto" },
  reactionSuper: { color: color.superheart },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  title: {
    ...typeScale.title,
    color: color.textPrimary,
    textAlign: "center",
  },
});
