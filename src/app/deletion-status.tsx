import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect } from "react";

import {
  loadAuthenticatedDeletionStatus,
  loadDeletionReceipt,
  requestAccountDeletion,
} from "@/features/account-deletion/account-deletion-api";
import { DeletionStatusScreen } from "@/features/account-deletion/deletion-status-screen";
import {
  clearPendingAccountDeletion,
  readPendingAccountDeletion,
  saveDeletionReceiptId,
} from "@/features/account-deletion/deletion-storage";
import { useAuth } from "@/features/auth/auth-provider";
import { supabaseUrl } from "@/lib/supabase";

export default function DeletionStatusRoute() {
  const { signOut, user } = useAuth();
  const pendingQuery = useQuery({
    queryFn: () => readPendingAccountDeletion(supabaseUrl, user?.id),
    queryKey: [
      "account-deletion",
      "local-record",
      supabaseUrl,
      user?.id ?? "signed-out",
    ],
    staleTime: Infinity,
  });
  const pending = pendingQuery.data ?? null;

  const statusQuery = useQuery({
    enabled: !pendingQuery.isPending,
    queryFn: async () => {
      if (pending) return await loadDeletionReceipt(pending);
      if (user) return await loadAuthenticatedDeletionStatus();
      return null;
    },
    // Never put the bearer capability or its digest in a cache key.
    queryKey: [
      "account-deletion",
      "status",
      supabaseUrl,
      pending?.receiptId ?? user?.id ?? "none",
    ],
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && !["complete", "dead"].includes(status) ? 5_000 : false;
    },
  });

  useEffect(() => {
    if (statusQuery.data?.status === "complete") {
      void clearPendingAccountDeletion(supabaseUrl);
    }
  }, [statusQuery.data?.status]);

  async function retry() {
    // No receipt can mean the request never reached the server. While the Auth
    // session still exists, replay the exact persisted command before polling.
    if (pending && user && !statusQuery.data) {
      try {
        const result = await requestAccountDeletion(pending);
        await saveDeletionReceiptId(pending, result.receipt_id);
      } catch {
        // Refetch below owns the safe visible error state.
      }
    }
    await statusQuery.refetch();
  }

  async function dismiss() {
    await clearPendingAccountDeletion(supabaseUrl);
    if (user) await signOut();
    router.replace("/sign-in");
  }

  return (
    <DeletionStatusScreen
      error={pendingQuery.isError || statusQuery.isError}
      isLoading={pendingQuery.isPending || statusQuery.isPending}
      onDismiss={() => void dismiss()}
      onRetry={() => void retry()}
      status={statusQuery.data ?? null}
    />
  );
}
