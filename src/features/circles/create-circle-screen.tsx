import { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useCircleMutations } from "./circle-queries";

type CreateCircleScreenProps = {
  userId: string | undefined;
  onCreated: (circleId: string) => void;
};

export function CreateCircleScreen({
  userId,
  onCreated,
}: CreateCircleScreenProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const { createCircle } = useCircleMutations(userId);

  async function handleCreate() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      const result = await createCircle.mutateAsync(name);
      if (result.kind === "error") return setError(result.message);
      onCreated(result.value.id);
    } catch {
      setError("We couldn’t create that Circle. Check your connection.");
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.safeArea}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Make a Circle</Text>
          <Text style={styles.subtitle}>
            A small private space for the people you actually share life with.
          </Text>
          <View style={styles.field}>
            <Text style={styles.label}>Circle name</Text>
            <TextInput
              accessibilityLabel="Circle name"
              autoCapitalize="words"
              autoFocus
              maxLength={50}
              onChangeText={setName}
              placeholder="e.g. The Tuesday Crew"
              returnKeyType="done"
              style={styles.input}
              value={name}
            />
            <Text style={styles.hint}>{name.trim().length}/50</Text>
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={createCircle.isPending}
            onPress={() => void handleCreate()}
            style={[
              styles.primaryButton,
              createCircle.isPending && styles.disabled,
            ]}
          >
            {createCircle.isPending ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryLabel}>Create Circle</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { gap: 20, padding: 24 },
  disabled: { opacity: 0.6 },
  error: { color: "#B42318", fontSize: 14, lineHeight: 20 },
  field: { gap: 8 },
  hint: { color: "#7B8794", fontSize: 13, textAlign: "right" },
  input: {
    backgroundColor: "#FFFFFF",
    borderColor: "#9FB3C8",
    borderRadius: 12,
    borderWidth: 1,
    color: "#102A43",
    fontSize: 17,
    minHeight: 52,
    paddingHorizontal: 14,
  },
  label: { color: "#102A43", fontSize: 15, fontWeight: "800" },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 52,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  subtitle: { color: "#52606D", fontSize: 16, lineHeight: 24 },
  title: { color: "#102A43", fontSize: 32, fontWeight: "800" },
});
