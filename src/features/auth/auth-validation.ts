import type { EmailPasswordCredentials } from "@/features/auth/auth-actions";

export type AuthFormMode = "sign-in" | "sign-up";

export type AuthFormErrors = Partial<
  Record<"email" | "password" | "confirmPassword", string>
>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCredentials(
  mode: AuthFormMode,
  credentials: EmailPasswordCredentials,
  confirmPassword: string,
) {
  const errors: AuthFormErrors = {};
  const email = credentials.email.trim();

  if (!email) {
    errors.email = "Enter your email address.";
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.email = "Enter a valid email address.";
  }

  if (!credentials.password) {
    errors.password = "Enter your password.";
  } else if (mode === "sign-up" && credentials.password.length < 8) {
    errors.password = "Use at least 8 characters.";
  }

  if (mode === "sign-up" && confirmPassword !== credentials.password) {
    errors.confirmPassword = "Passwords do not match.";
  }

  return errors;
}
