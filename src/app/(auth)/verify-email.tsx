import { useLocalSearchParams } from "expo-router";

import {
  resendSignupCode,
  verifyEmailCode,
} from "@/features/auth/auth-actions";
import { VerifyEmailScreen } from "@/features/auth/verify-email-screen";

export default function VerifyEmailRoute() {
  const { email: emailParameter } = useLocalSearchParams<{ email?: string }>();
  const email = typeof emailParameter === "string" ? emailParameter : null;

  return (
    <VerifyEmailScreen
      email={email}
      onResend={resendSignupCode}
      onVerify={verifyEmailCode}
    />
  );
}
