import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { CreatedInvite } from "./circle-actions";
import { useCircleDetail, useCircleMutations } from "./circle-queries";

type CircleDetailScreenProps = {
  circleId: string;
  userId: string | undefined;
  onExited: () => void;
};

type Confirmation =
  | { kind: "leave" }
  | { kind: "delete" }
  | { kind: "remove"; userId: string; displayName: string }
  | { kind: "demote"; userId: string; displayName: string }
  | null;

export function CircleDetailScreen({
  circleId,
  userId,
  onExited,
}: CircleDetailScreenProps) {
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(
    null,
  );
  const [isActing, setIsActing] = useState(false);
  const inFlight = useRef(false);
  const detailQuery = useCircleDetail(userId, circleId);
  const mutations = useCircleMutations(userId);

  if (detailQuery.isPending) return <LoadingCircle />;
  if (detailQuery.isError || !detailQuery.data)
    return <CircleDetailError onRetry={() => void detailQuery.refetch()} />;

  const { circle, invites, members } = detailQuery.data;
  const caller = members.find((member) => member.user_id === userId);
  const isAdmin = caller?.role === "admin";

  async function runAction(
    action: () => Promise<
      { kind: "success" } | { kind: "error"; message: string }
    >,
    onSuccess?: () => void,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsActing(true);
    setError(null);
    try {
      const result = await action();
      if (result.kind === "error") return setError(result.message);
      setConfirmation(null);
      onSuccess?.();
    } catch {
      setError("We couldn’t make that change. Check your connection.");
    } finally {
      inFlight.current = false;
      setIsActing(false);
    }
  }

  async function handleCreateInvite() {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsActing(true);
    setError(null);
    try {
      const result = await mutations.createDefaultInvite.mutateAsync(circleId);
      if (result.kind === "error") return setError(result.message);
      setCreatedInvite(result.value);
    } catch {
      setError("We couldn’t create an invitation. Check your connection.");
    } finally {
      inFlight.current = false;
      setIsActing(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>PRIVATE CIRCLE</Text>
        <Text style={styles.title}>{circle.name}</Text>
        <Text style={styles.subtitle}>
          {members.length} {members.length === 1 ? "member" : "members"} ·{" "}
          {isAdmin ? "You’re an admin" : "You’re a member"}
        </Text>

        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}

        {createdInvite ? (
          <View
            accessibilityLabel="New group invitation"
            style={styles.tokenCard}
          >
            <Text style={styles.tokenTitle}>Share this in the group chat</Text>
            <Text style={styles.tokenBody}>
              Up to 10 friends can use it over seven days. It will not be shown
              again after you dismiss this card.
            </Text>
            <Text selectable style={styles.token}>
              {createdInvite.token}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setCreatedInvite(null);
                mutations.createDefaultInvite.reset();
              }}
              style={styles.dismissButton}
            >
              <Text style={styles.dismissLabel}>I saved it</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Members</Text>
          <View style={styles.cardList}>
            {members.map((member) => (
              <MemberRow
                isAdmin={isAdmin}
                isCaller={member.user_id === userId}
                key={member.user_id}
                member={member}
                onDemote={() =>
                  setConfirmation({
                    kind: "demote",
                    userId: member.user_id,
                    displayName: member.display_name,
                  })
                }
                onPromote={() =>
                  void runAction(() =>
                    mutations.setMemberRole.mutateAsync({
                      circleId,
                      role: "admin",
                      userId: member.user_id,
                    }),
                  )
                }
                onRemove={() =>
                  setConfirmation({
                    kind: "remove",
                    userId: member.user_id,
                    displayName: member.display_name,
                  })
                }
              />
            ))}
          </View>
        </View>

        {isAdmin ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Invitations</Text>
            <Pressable
              accessibilityRole="button"
              disabled={mutations.createDefaultInvite.isPending}
              onPress={() => void handleCreateInvite()}
              style={[
                styles.primaryButton,
                mutations.createDefaultInvite.isPending && styles.disabled,
              ]}
            >
              {mutations.createDefaultInvite.isPending ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryLabel}>Make group invite</Text>
              )}
            </Pressable>
            {invites.length === 0 ? (
              <Text style={styles.emptyText}>
                No invitations have been created yet.
              </Text>
            ) : (
              invites.map((invite) => (
                <View key={invite.id} style={styles.inviteRow}>
                  <View style={styles.inviteCopy}>
                    <Text style={styles.inviteTitle}>
                      {invite.revoked_at
                        ? "Revoked invitation"
                        : invite.use_count >= invite.max_uses
                          ? "Full invitation"
                          : "Active invitation"}
                    </Text>
                    <Text style={styles.inviteBody}>
                      Used {invite.use_count}/{invite.max_uses} · expires{" "}
                      {formatDate(invite.expires_at)}
                    </Text>
                  </View>
                  {!invite.revoked_at && invite.use_count < invite.max_uses ? (
                    <Pressable
                      accessibilityLabel="Revoke invitation"
                      accessibilityRole="button"
                      onPress={() =>
                        void runAction(() =>
                          mutations.revokeInvite.mutateAsync({
                            circleId,
                            inviteId: invite.id,
                          }),
                        )
                      }
                      style={styles.textButton}
                    >
                      <Text style={styles.dangerLabel}>Revoke</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))
            )}
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Leave Circle</Text>
          <Text style={styles.body}>
            You’ll lose access to this Circle’s future activity. Your past
            contributions stay in the group history unless you delete them
            later.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setConfirmation({ kind: "leave" })}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryLabel}>Leave Circle</Text>
          </Pressable>
        </View>

        {isAdmin ? (
          <View style={styles.dangerSection}>
            <Text style={styles.dangerTitle}>Delete Circle</Text>
            <Text style={styles.body}>
              This Circle has no posts yet. Deleting it permanently removes the
              Circle for every member, along with its memberships and
              invitations. This cannot be undone.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setConfirmation({ kind: "delete" })}
              style={styles.dangerButton}
            >
              <Text style={styles.dangerButtonLabel}>
                Delete Circle forever
              </Text>
            </Pressable>
          </View>
        ) : null}

        {confirmation ? (
          <ConfirmationPanel
            confirmation={confirmation}
            disabled={isActing}
            onCancel={() => setConfirmation(null)}
            onConfirm={() => {
              if (confirmation.kind === "leave")
                return void runAction(
                  () => mutations.leaveCircle.mutateAsync(circleId),
                  onExited,
                );
              if (confirmation.kind === "delete")
                return void runAction(
                  () => mutations.requestCircleDeletion.mutateAsync(circleId),
                  onExited,
                );
              if (confirmation.kind === "remove")
                return void runAction(() =>
                  mutations.removeMember.mutateAsync({
                    circleId,
                    userId: confirmation.userId,
                  }),
                );
              return void runAction(() =>
                mutations.setMemberRole.mutateAsync({
                  circleId,
                  role: "member",
                  userId: confirmation.userId,
                }),
              );
            }}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function MemberRow({
  member,
  isAdmin,
  isCaller,
  onPromote,
  onDemote,
  onRemove,
}: {
  member: { user_id: string; display_name: string; role: string };
  isAdmin: boolean;
  isCaller: boolean;
  onPromote: () => void;
  onDemote: () => void;
  onRemove: () => void;
}) {
  return (
    <View style={styles.memberRow}>
      <View style={styles.memberAvatar}>
        <Text style={styles.memberAvatarLabel}>
          {member.display_name.slice(0, 1).toUpperCase()}
        </Text>
      </View>
      <View style={styles.memberCopy}>
        <Text style={styles.memberName}>
          {member.display_name}
          {isCaller ? " (you)" : ""}
        </Text>
        <Text style={styles.memberRole}>
          {member.role === "admin" ? "Admin" : "Member"}
        </Text>
      </View>
      {isAdmin && !isCaller ? (
        <View style={styles.memberActions}>
          {member.role === "admin" ? (
            <Pressable
              accessibilityLabel={`Demote ${member.display_name}`}
              accessibilityRole="button"
              onPress={onDemote}
              style={styles.textButton}
            >
              <Text style={styles.textButtonLabel}>Demote</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel={`Make ${member.display_name} an admin`}
              accessibilityRole="button"
              onPress={onPromote}
              style={styles.textButton}
            >
              <Text style={styles.textButtonLabel}>Make admin</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityLabel={`Remove ${member.display_name}`}
            accessibilityRole="button"
            onPress={onRemove}
            style={styles.textButton}
          >
            <Text style={styles.dangerLabel}>Remove</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function ConfirmationPanel({
  confirmation,
  disabled,
  onCancel,
  onConfirm,
}: {
  confirmation: Exclude<Confirmation, null>;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy =
    confirmation.kind === "leave"
      ? [
          "Leave this Circle?",
          "You will lose access to it immediately.",
          "Leave Circle",
        ]
      : confirmation.kind === "delete"
        ? [
            "Delete this Circle forever?",
            "This action is irreversible.",
            "Delete Circle",
          ]
        : confirmation.kind === "remove"
          ? [
              `Remove ${confirmation.displayName}?`,
              "They will lose access immediately.",
              "Remove member",
            ]
          : [
              `Demote ${confirmation.displayName}?`,
              "They will no longer be able to manage members or invitations.",
              "Demote admin",
            ];
  return (
    <View accessibilityRole="alert" style={styles.confirmation}>
      <Text style={styles.confirmationTitle}>{copy[0]}</Text>
      <Text style={styles.body}>{copy[1]}</Text>
      {disabled ? (
        <Text accessibilityRole="alert" style={styles.pendingText}>
          Making this change…
        </Text>
      ) : null}
      <View style={styles.confirmationActions}>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={onCancel}
          style={styles.cancelButton}
        >
          <Text style={styles.textButtonLabel}>Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={onConfirm}
          style={[styles.confirmButton, disabled && styles.disabled]}
        >
          {disabled ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.confirmLabel}>{copy[2]}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function LoadingCircle() {
  return (
    <View
      accessibilityLabel="Loading Circle"
      accessibilityRole="progressbar"
      style={styles.centered}
    >
      <ActivityIndicator size="large" />
    </View>
  );
}
function CircleDetailError({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.centered}>
      <Text style={styles.errorTitle}>We couldn’t load this Circle</Text>
      <Text style={styles.body}>Check your connection and try again.</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={styles.primaryButton}
      >
        <Text style={styles.primaryLabel}>Try again</Text>
      </Pressable>
    </View>
  );
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

const styles = StyleSheet.create({
  body: { color: "#52606D", fontSize: 15, lineHeight: 22 },
  cancelButton: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    minHeight: 46,
  },
  cardList: { gap: 10 },
  centered: {
    alignItems: "center",
    backgroundColor: "#F5FAFF",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  confirmButton: {
    alignItems: "center",
    backgroundColor: "#B42318",
    borderRadius: 12,
    flex: 1,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 10,
  },
  confirmLabel: { color: "#FFFFFF", fontWeight: "800", textAlign: "center" },
  confirmation: {
    backgroundColor: "#FFFFFF",
    borderColor: "#F97066",
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 18,
  },
  confirmationActions: { flexDirection: "row", gap: 8 },
  confirmationTitle: { color: "#102A43", fontSize: 18, fontWeight: "800" },
  content: { gap: 20, padding: 24 },
  dangerButton: {
    alignItems: "center",
    backgroundColor: "#B42318",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 52,
  },
  dangerButtonLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  dangerLabel: { color: "#B42318", fontSize: 13, fontWeight: "800" },
  dangerSection: {
    backgroundColor: "#FFF5F5",
    borderColor: "#F97066",
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  dangerTitle: { color: "#B42318", fontSize: 18, fontWeight: "800" },
  disabled: { opacity: 0.6 },
  dismissButton: {
    alignItems: "center",
    borderColor: "#208AEF",
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 46,
  },
  dismissLabel: { color: "#1268B3", fontWeight: "800" },
  emptyText: { color: "#52606D", fontSize: 14 },
  error: { color: "#B42318", fontSize: 14, lineHeight: 20 },
  errorTitle: {
    color: "#102A43",
    fontSize: 24,
    fontWeight: "800",
    textAlign: "center",
  },
  eyebrow: {
    color: "#1268B3",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
  },
  inviteBody: { color: "#52606D", fontSize: 13, lineHeight: 18 },
  inviteCopy: { flex: 1, gap: 2 },
  inviteRow: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#D9E2EC",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 14,
  },
  inviteTitle: { color: "#102A43", fontSize: 15, fontWeight: "800" },
  memberActions: { alignItems: "flex-end", gap: 5 },
  pendingText: { color: "#52606D", fontSize: 14, fontWeight: "700" },
  memberAvatar: {
    alignItems: "center",
    backgroundColor: "#D9EFFF",
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  memberAvatarLabel: { color: "#1268B3", fontSize: 16, fontWeight: "800" },
  memberCopy: { flex: 1, gap: 2 },
  memberName: { color: "#102A43", fontSize: 16, fontWeight: "800" },
  memberRole: { color: "#52606D", fontSize: 13 },
  memberRow: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#D9E2EC",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 66,
    padding: 14,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 16,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  secondaryButton: {
    alignItems: "center",
    borderColor: "#9FB3C8",
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 52,
  },
  secondaryLabel: { color: "#334E68", fontSize: 16, fontWeight: "800" },
  section: { gap: 12 },
  sectionTitle: { color: "#102A43", fontSize: 20, fontWeight: "800" },
  subtitle: { color: "#52606D", fontSize: 16, lineHeight: 24 },
  textButton: { minHeight: 30, paddingHorizontal: 4, paddingVertical: 4 },
  textButtonLabel: { color: "#1268B3", fontSize: 13, fontWeight: "800" },
  title: { color: "#102A43", fontSize: 32, fontWeight: "800" },
  token: {
    backgroundColor: "#FFFFFF",
    borderColor: "#9FB3C8",
    borderRadius: 10,
    borderWidth: 1,
    color: "#102A43",
    fontFamily: "Menlo",
    fontSize: 12,
    lineHeight: 18,
    padding: 12,
  },
  tokenBody: { color: "#334E68", fontSize: 14, lineHeight: 20 },
  tokenCard: {
    backgroundColor: "#E6F4FE",
    borderColor: "#A9D6F5",
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  tokenTitle: { color: "#102A43", fontSize: 18, fontWeight: "800" },
});
