import { signInWithPassword } from "@/features/auth/auth-actions";
import { EmailPasswordForm } from "@/features/auth/email-password-form";

export default function SignInScreen() {
  return <EmailPasswordForm mode="sign-in" onSubmit={signInWithPassword} />;
}
