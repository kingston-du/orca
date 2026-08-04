import { useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { AppButton } from "@/components/app-button";
import { Field } from "@/components/field";
import { Icon } from "@/components/icon";
import { Sheet } from "@/components/sheet";
import { color, spacing, typeScale } from "@/constants/design";
import { PersonRow } from "@/features/friends/person-row";
import {
  lookupProfileExact,
  type FriendRequestSummary,
  type ProfileLookup,
} from "@/features/friends/friends-api";

/** The canonical username shape, so an obviously invalid entry never costs a
 * round trip. It is the same expression the server normalizes against. */
const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,19}$/;

type AddFriendSheetProps = {
  commandPending: boolean;
  onAcceptRequest: (request: FriendRequestSummary) => void;
  onCancelRequest: (request: FriendRequestSummary) => void;
  onClose: () => void;
  onLookupAction: (lookup: ProfileLookup) => void;
  onOpenInviteLink: () => void;
  onRejectRequest: (request: FriendRequestSummary) => void;
  requests: FriendRequestSummary[] | undefined;
  requestsError: boolean;
  requestsPending: boolean;
  onRetryRequests: () => void;
  visible: boolean;
};

/**
 * Everything about *adding* people, behind the one control in People's header.
 *
 * Requests come first because they are someone else waiting on an answer, and
 * search second because it is a thing the viewer chose to do. Both used to be
 * permanent sections of the People screen, which meant the tab's first screenful
 * was administration rather than the friends it is named after.
 *
 * The search field resolves **one exact username**. Splotty has no fuzzy directory
 * by design: a prefix search over a private social graph is an enumeration
 * tool, so the field says plainly that it wants a whole username rather than
 * pretending to be a discovery surface. A blocked account and an account that
 * never existed return the same answer, deliberately.
 */
export function AddFriendSheet({
  commandPending,
  onAcceptRequest,
  onCancelRequest,
  onClose,
  onLookupAction,
  onOpenInviteLink,
  onRejectRequest,
  onRetryRequests,
  requests,
  requestsError,
  requestsPending,
  visible,
}: AddFriendSheetProps) {
  const [username, setUsername] = useState("");
  const [lookup, setLookup] = useState<ProfileLookup | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function search() {
    // The keyboard's return key is now the only way in, and it can fire again
    // while the first lookup is still out.
    if (searching) return;

    if (!USERNAME_PATTERN.test(username.trim().toLowerCase())) {
      setLookup(null);
      setMessage("Enter an exact Splotty username.");
      return;
    }

    setSearching(true);
    setMessage(null);
    try {
      const result = await lookupProfileExact(username);
      setLookup(result);
      if (!result) setMessage("No available account matches that username.");
    } catch {
      setLookup(null);
      setMessage("Search is unavailable. Try again.");
    } finally {
      setSearching(false);
    }
  }

  function close() {
    setUsername("");
    setLookup(null);
    setMessage(null);
    onClose();
  }

  return (
    <Sheet onClose={close} title="Add friends" visible={visible}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        testID="add-friend-scroll"
      >
        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Requests
          </Text>
          {requestsPending ? <ActivityIndicator /> : null}
          {requestsError ? (
            <View style={styles.retryRow}>
              <Text style={styles.body}>Couldn’t load requests.</Text>
              <AppButton
                label="Try again"
                onPress={onRetryRequests}
                variant="text"
              />
            </View>
          ) : null}
          {requests?.length === 0 ? (
            <Text style={styles.body}>No pending requests.</Text>
          ) : null}
          {requests?.map((request) => {
            const incoming = request.direction === "incoming";
            return (
              <PersonRow
                action={incoming ? "Accept" : "Cancel"}
                disabled={commandPending}
                displayName={request.display_name}
                key={request.request_id}
                onAction={() =>
                  incoming ? onAcceptRequest(request) : onCancelRequest(request)
                }
                onSecondaryAction={() => onRejectRequest(request)}
                secondaryAction={incoming ? "Reject" : undefined}
                username={request.username}
              />
            );
          })}
        </View>

        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Find someone
          </Text>
          <Field
            accessibilityHint="Press search on the keyboard to look them up"
            accessibilityLabel="Friend’s username"
            autoCapitalize="none"
            autoCorrect={false}
            leading={
              <Icon name="search" size={16} tint={color.textSecondary} />
            }
            onChangeText={setUsername}
            onSubmitEditing={() => void search()}
            placeholder="Full username, e.g. ada"
            returnKeyType="search"
            testID="add-friend-search"
            value={username}
          />
          {searching ? (
            <ActivityIndicator accessibilityLabel="Searching" />
          ) : null}
          {/* No Search button. The field's return key is already labelled
           * "search" and submits, so a second control below it was a duplicate
           * of the one the keyboard puts under the author's thumb — and it sat
           * exactly where the keyboard covers. `searching` still gates the
           * field so a second submit cannot race the first. */}
          <Text style={styles.hint}>
            Splotty finds people by their exact username, so ask a friend for
            theirs — or send them your invite link.
          </Text>
          {message ? (
            <Text
              accessibilityLiveRegion="polite"
              style={styles.body}
              testID="add-friend-message"
            >
              {message}
            </Text>
          ) : null}
          {lookup ? (
            <PersonRow
              action={lookupAction(lookup.relationship_state)}
              disabled={commandPending}
              displayName={lookup.display_name}
              onAction={() => onLookupAction(lookup)}
              username={lookup.username}
            />
          ) : null}
        </View>

        <AppButton
          label="My invite link"
          onPress={onOpenInviteLink}
          variant="text"
        />
      </ScrollView>
    </Sheet>
  );
}

/** What the viewer may do about a person, given where the two already stand. */
export function lookupAction(state: string) {
  if (state === "none") return "Add";
  if (state === "incoming") return "Accept";
  if (state === "outgoing") return "Cancel";
  return undefined;
}

const styles = StyleSheet.create({
  body: { ...typeScale.cardBody, color: color.textSecondary },
  content: { gap: spacing.xl, paddingBottom: spacing.lg },
  hint: { ...typeScale.caption, color: color.textSecondary },
  retryRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  section: { gap: spacing.md },
  sectionTitle: { ...typeScale.sectionLabel, color: color.textSecondary },
});
