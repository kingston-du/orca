import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { circleActions, loadCircleDetail, loadCircleHub } from "./circle-api";

export function circleHubQueryKey(userId: string) {
  return ["circles", userId] as const;
}

export function circleDetailQueryKey(userId: string, circleId: string) {
  return ["circles", userId, circleId] as const;
}

export function useCircleHub(userId: string | undefined) {
  return useQuery({
    enabled: Boolean(userId),
    queryFn: loadCircleHub,
    queryKey: circleHubQueryKey(userId ?? "signed-out"),
    staleTime: 60 * 1000,
  });
}

export function useCircleDetail(userId: string | undefined, circleId: string) {
  return useQuery({
    enabled: Boolean(userId && circleId),
    queryFn: () => loadCircleDetail(circleId),
    queryKey: circleDetailQueryKey(userId ?? "signed-out", circleId),
    staleTime: 30 * 1000,
  });
}

export function useCircleMutations(userId: string | undefined) {
  const queryClient = useQueryClient();
  const hubKey = circleHubQueryKey(userId ?? "signed-out");

  function invalidateCircles(circleId?: string) {
    const requests = [queryClient.invalidateQueries({ queryKey: hubKey })];

    if (circleId) {
      requests.push(
        queryClient.invalidateQueries({
          queryKey: circleDetailQueryKey(userId ?? "signed-out", circleId),
        }),
      );
    }

    return Promise.all(requests);
  }

  const createCircle = useMutation({
    mutationFn: circleActions.createCircle,
    onSuccess: async (result) => {
      if (result.kind === "success") {
        await invalidateCircles(result.value.id);
      }
    },
  });
  const previewInvite = useMutation({
    mutationFn: circleActions.previewInvite,
  });
  const redeemInvite = useMutation({
    mutationFn: circleActions.redeemInvite,
    onSuccess: async (result) => {
      if (result.kind === "success") {
        await invalidateCircles(result.value.circleId);
      }
    },
  });
  const createDefaultInvite = useMutation({
    gcTime: 0,
    mutationFn: circleActions.createDefaultInvite,
    onSuccess: async (result) => {
      if (result.kind === "success") {
        await invalidateCircles(result.value.circle_id);
      }
    },
  });
  const revokeInvite = useMutation({
    mutationFn: ({
      circleId,
      inviteId,
    }: {
      circleId: string;
      inviteId: string;
    }) => circleActions.revokeInvite(circleId, inviteId),
    onSuccess: async (result, variables) => {
      if (result.kind === "success") {
        await invalidateCircles(variables.circleId);
      }
    },
  });
  const setMemberRole = useMutation({
    mutationFn: ({
      circleId,
      role,
      userId: memberId,
    }: {
      circleId: string;
      role: "admin" | "member";
      userId: string;
    }) => circleActions.setMemberRole(circleId, memberId, role),
    onSuccess: async (result, variables) => {
      if (result.kind === "success") {
        await invalidateCircles(variables.circleId);
      }
    },
  });
  const removeMember = useMutation({
    mutationFn: ({
      circleId,
      userId: memberId,
    }: {
      circleId: string;
      userId: string;
    }) => circleActions.removeMember(circleId, memberId),
    onSuccess: async (result, variables) => {
      if (result.kind === "success") {
        await invalidateCircles(variables.circleId);
      }
    },
  });
  const leaveCircle = useMutation({
    mutationFn: circleActions.leaveCircle,
    onSuccess: async (result, circleId) => {
      if (result.kind === "success") {
        queryClient.removeQueries({
          queryKey: circleDetailQueryKey(userId ?? "signed-out", circleId),
        });
        await invalidateCircles(circleId);
      }
    },
  });
  const requestCircleDeletion = useMutation({
    mutationFn: circleActions.requestCircleDeletion,
    onSuccess: async (result, circleId) => {
      if (result.kind === "success") {
        queryClient.removeQueries({
          queryKey: circleDetailQueryKey(userId ?? "signed-out", circleId),
        });
        await invalidateCircles(circleId);
      }
    },
  });

  return {
    createCircle,
    createDefaultInvite,
    leaveCircle,
    previewInvite,
    redeemInvite,
    removeMember,
    requestCircleDeletion,
    revokeInvite,
    setMemberRole,
  };
}
