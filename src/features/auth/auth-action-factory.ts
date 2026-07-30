import type { AuthError, SupabaseClient } from "@supabase/supabase-js";

export type EmailPasswordCredentials = {
  email: string;
  password: string;
};

export type AuthSubmissionResult =
  | {
      kind: "success";
      message?: string;
      nextStep?: { kind: "verify-email"; email: string };
    }
  | { kind: "error"; message: string };

type AuthAction =
  "sign-in" | "sign-up" | "verify-email" | "resend-code" | "reset-password";

type EmailAuthClient = Pick<
  SupabaseClient["auth"],
  | "resend"
  | "resetPasswordForEmail"
  | "signInWithPassword"
  | "signOut"
  | "signUp"
  | "updateUser"
  | "verifyOtp"
>;

function authErrorMessage(error: AuthError, action: AuthAction) {
  switch (error.code) {
    case "invalid_credentials":
      return "Email or password is incorrect.";
    case "email_not_confirmed":
      return "Confirm your email before signing in.";
    case "weak_password":
      return "Choose a stronger password and try again.";
    case "same_password":
      return "Choose a password you haven’t used for this account.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Too many attempts. Wait a moment and try again.";
    case "otp_expired":
      return "That code is invalid or expired. Request a new one and try again.";
    case "email_address_invalid":
      return "Enter a valid email address.";
    case "email_address_not_authorized":
      return "Email delivery is not configured for this address yet.";
    case "signup_disabled":
      return "New account creation is temporarily unavailable.";
    case "request_timeout":
      return "The request timed out. Check your connection and try again.";
    default:
      if (action === "sign-in") {
        return "We couldn’t sign you in. Check your connection and try again.";
      }

      if (action === "verify-email") {
        return "We couldn’t verify that code. Check it and try again.";
      }

      if (action === "resend-code") {
        return "We couldn’t send a new code. Check your connection and try again.";
      }

      if (action === "reset-password") {
        return "We couldn’t update your password. Try again.";
      }

      return "We couldn’t create that account. Check your connection and try again.";
  }
}

function normalizedCredentials(credentials: EmailPasswordCredentials) {
  return {
    email: credentials.email.trim().toLowerCase(),
    password: credentials.password,
  };
}

export function createEmailAuthActions(auth: EmailAuthClient) {
  async function signInWithPassword(
    credentials: EmailPasswordCredentials,
  ): Promise<AuthSubmissionResult> {
    const { error } = await auth.signInWithPassword(
      normalizedCredentials(credentials),
    );

    return error
      ? { kind: "error", message: authErrorMessage(error, "sign-in") }
      : { kind: "success" };
  }

  async function signUpWithPassword(
    credentials: EmailPasswordCredentials,
  ): Promise<AuthSubmissionResult> {
    const normalized = normalizedCredentials(credentials);
    const { data, error } = await auth.signUp(normalized);

    if (error) {
      return { kind: "error", message: authErrorMessage(error, "sign-up") };
    }

    return data.session
      ? { kind: "success" }
      : {
          kind: "success",
          nextStep: {
            kind: "verify-email",
            email: normalized.email,
          },
        };
  }

  async function verifyEmailCode(
    email: string,
    token: string,
  ): Promise<AuthSubmissionResult> {
    const { error } = await auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token,
      type: "email",
    });

    return error
      ? { kind: "error", message: authErrorMessage(error, "verify-email") }
      : { kind: "success" };
  }

  async function resendSignupCode(
    email: string,
  ): Promise<AuthSubmissionResult> {
    const { error } = await auth.resend({
      email: email.trim().toLowerCase(),
      type: "signup",
    });

    return error
      ? { kind: "error", message: authErrorMessage(error, "resend-code") }
      : { kind: "success", message: "A new code is on its way." };
  }

  async function requestPasswordReset(
    email: string,
  ): Promise<AuthSubmissionResult> {
    const { error } = await auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
    );

    if (
      error?.code === "over_request_rate_limit" ||
      error?.code === "over_email_send_rate_limit" ||
      error?.code === "request_timeout"
    ) {
      return {
        kind: "error",
        message: authErrorMessage(error, "resend-code"),
      };
    }

    return {
      kind: "success",
      message:
        "If an account exists for that email, a reset code is on its way.",
    };
  }

  async function resetPasswordWithCode(
    email: string,
    token: string,
    password: string,
  ): Promise<AuthSubmissionResult> {
    const { error: verificationError } = await auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token,
      type: "recovery",
    });

    if (verificationError) {
      return {
        kind: "error",
        message: authErrorMessage(verificationError, "verify-email"),
      };
    }

    const { error: updateError } = await auth.updateUser({ password });

    if (updateError) {
      await auth.signOut({ scope: "local" });

      return {
        kind: "error",
        message: authErrorMessage(updateError, "reset-password"),
      };
    }

    return { kind: "success", message: "Your password has been updated." };
  }

  return {
    requestPasswordReset,
    resendSignupCode,
    resetPasswordWithCode,
    signInWithPassword,
    signUpWithPassword,
    verifyEmailCode,
  };
}
