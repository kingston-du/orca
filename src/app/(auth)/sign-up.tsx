import { signUpWithPassword } from "@/features/auth/auth-actions";
import { EmailPasswordForm } from "@/features/auth/email-password-form";

export default function SignUpScreen() {
  return <EmailPasswordForm mode="sign-up" onSubmit={signUpWithPassword} />;
}
