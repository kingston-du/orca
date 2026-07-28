import { useRouter } from "expo-router";

import { signUpWithPassword } from "@/features/auth/auth-actions";
import type { AuthSubmissionResult } from "@/features/auth/auth-actions";
import { EmailPasswordForm } from "@/features/auth/email-password-form";

export default function SignUpScreen() {
  const router = useRouter();

  function handleSuccess(
    result: Extract<AuthSubmissionResult, { kind: "success" }>,
  ) {
    if (result.nextStep?.kind === "verify-email") {
      router.replace({
        pathname: "/verify-email",
        params: { email: result.nextStep.email },
      });
    }
  }

  return (
    <EmailPasswordForm
      mode="sign-up"
      onSubmit={signUpWithPassword}
      onSuccess={handleSuccess}
    />
  );
}
