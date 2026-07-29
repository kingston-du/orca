import type { EmailPasswordCredentials } from "@/features/auth/auth-actions";

export type AuthFormMode = "sign-in" | "sign-up";

export type AuthFormErrors = Partial<
  Record<"email" | "password" | "confirmPassword" | "inviteCode", string>
>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_CODE_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeInviteCode(value: string) {
  return value.trim().toLowerCase();
}

export function validateEmail(email: string) {
  const normalizedEmail = email.trim();

  if (!normalizedEmail) {
    return "Enter your email address.";
  }

  if (!EMAIL_PATTERN.test(normalizedEmail)) {
    return "Enter a valid email address.";
  }
}

export function validateNewPassword(password: string, confirmPassword: string) {
  const errors: Pick<AuthFormErrors, "password" | "confirmPassword"> = {};

  if (!password) {
    errors.password = "Enter a new password.";
  } else if (password.length < 8) {
    errors.password = "Use at least 8 characters.";
  }

  if (confirmPassword !== password) {
    errors.confirmPassword = "Passwords do not match.";
  }

  return errors;
}

export function validateCredentials(
  mode: AuthFormMode,
  credentials: EmailPasswordCredentials,
  confirmPassword: string,
) {
  const errors: AuthFormErrors = {};
  const emailError = validateEmail(credentials.email);

  if (emailError) {
    errors.email = emailError;
  }

  if (!credentials.password) {
    errors.password = "Enter your password.";
  } else if (mode === "sign-up" && credentials.password.length < 8) {
    errors.password = "Use at least 8 characters.";
  }

  if (mode === "sign-up" && confirmPassword !== credentials.password) {
    errors.confirmPassword = "Passwords do not match.";
  }

  if (
    mode === "sign-up" &&
    !INVITE_CODE_PATTERN.test(normalizeInviteCode(credentials.inviteCode ?? ""))
  ) {
    errors.inviteCode =
      "Enter the 64-character invitation code from your friend.";
  }

  return errors;
}
