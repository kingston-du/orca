export function getAuthRouteAccess(
  hasSession: boolean,
  isPasswordRecovery: boolean,
) {
  return {
    canEnterApp: hasSession && !isPasswordRecovery,
    canEnterAuth: !hasSession || isPasswordRecovery,
  };
}
