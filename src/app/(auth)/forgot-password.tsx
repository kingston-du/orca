import {
  requestPasswordReset,
  resetPasswordWithCode,
} from "@/features/auth/auth-actions";
import { PasswordRecoveryScreen } from "@/features/auth/password-recovery-screen";

export default function ForgotPasswordRoute() {
  return (
    <PasswordRecoveryScreen
      onRequest={requestPasswordReset}
      onReset={resetPasswordWithCode}
    />
  );
}
