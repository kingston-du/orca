import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Icon } from "@/components/icon";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Sheet } from "@/components/sheet";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import type { ComposerFriend } from "@/features/moments/composer/composer-reducer";
import { hapticSelection } from "@/lib/haptics";

export type PickerMode = "tag" | "recipient";

type FriendPickerSheetProps = {
  friends: ComposerFriend[];
  /** Recipients a tag has pinned into the audience; they cannot be removed. */
  lockedIds: Set<string>;
  mode: PickerMode;
  onClose: () => void;
  onToggle: (friendId: string) => void;
  selectedIds: string[];
  visible: boolean;
};

/**
 * One sheet, two jobs: choosing who is *in* a Moment (tags) and choosing who
 * may *see* it (recipients).
 *
 * They are the same interaction over the same list, and the composer's reducer
 * already enforces what makes them different — a tag forces its friend into the
 * audience, so a recipient row can be locked while a tag row never is. Two
 * separate sheets would have duplicated that list, its empty state, and its
 * accessibility naming for no gain.
 *
 * The accessible names are `Tag {name}` and `Share with {name}`, which is what
 * the reducer's own tests reach for.
 */
export function FriendPickerSheet({
  friends,
  lockedIds,
  mode,
  onClose,
  onToggle,
  selectedIds,
  visible,
}: FriendPickerSheetProps) {
  const tagging = mode === "tag";

  return (
    <Sheet
      onClose={onClose}
      title={tagging ? "Who’s here?" : "Who can see this"}
      visible={visible}
    >
      {friends.length === 0 ? (
        <Text style={styles.empty}>
          You have no friends yet, so this Moment stays private to you.
        </Text>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
        >
          {friends.map((friend) => {
            const selected = selectedIds.includes(friend.id);
            const locked = !tagging && lockedIds.has(friend.id);

            return (
              <Pressable
                accessibilityLabel={
                  tagging
                    ? `Tag ${friend.displayName}`
                    : `Share with ${friend.displayName}`
                }
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected, disabled: locked }}
                disabled={locked}
                key={friend.id}
                onPress={() => {
                  hapticSelection();
                  onToggle(friend.id);
                }}
                style={({ pressed }) => [
                  styles.row,
                  pressed && !locked ? styles.rowPressed : null,
                ]}
              >
                <ProfileAvatar
                  avatarPath={friend.avatarPath}
                  displayName={friend.displayName}
                  size={40}
                />
                <View style={styles.identity}>
                  <Text numberOfLines={1} style={styles.name}>
                    {friend.displayName}
                  </Text>
                  <Text numberOfLines={1} style={styles.handle}>
                    @{friend.username}
                  </Text>
                </View>
                {/* A tick in a filled box, not a coloured row: the selected
                 * state has to survive a viewer who cannot separate the two
                 * backgrounds. Locked rows say so in words. */}
                {locked ? (
                  <Text style={styles.locked}>Locked</Text>
                ) : (
                  <View
                    style={[styles.box, selected ? styles.boxChecked : null]}
                  >
                    {selected ? (
                      <Icon
                        name="check"
                        size={14}
                        tint={color.textInverse}
                        weight="bold"
                      />
                    ) : null}
                  </View>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: "center",
    borderColor: color.border,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    height: 24,
    justifyContent: "center",
    width: 24,
  },
  boxChecked: { backgroundColor: color.brand, borderColor: color.brand },
  empty: {
    ...typeScale.cardBody,
    color: color.textSecondary,
    paddingBottom: spacing.xl,
  },
  handle: { ...typeScale.caption, color: color.textSecondary },
  identity: { flex: 1, gap: 2 },
  list: { paddingBottom: spacing.lg },
  locked: { ...typeScale.caption, color: color.textSecondary },
  name: { ...typeScale.body, color: color.textPrimary },
  row: {
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: spacing.md,
    minHeight: MINIMUM_TOUCH_TARGET + spacing.md,
    paddingHorizontal: spacing.sm,
  },
  rowPressed: { backgroundColor: color.fillSubtle },
});
