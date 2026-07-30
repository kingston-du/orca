import { AuthError } from "@supabase/supabase-js";

import { createEmailAuthActions } from "@/features/auth/auth-action-factory";

const mockResend = jest.fn();
const mockResetPasswordForEmail = jest.fn();
const mockSignInWithPassword = jest.fn();
const mockSignOut = jest.fn();
const mockSignUp = jest.fn();
const mockUpdateUser = jest.fn();
const mockVerifyOtp = jest.fn();

describe("Auth actions", () => {
  const {
    requestPasswordReset,
    resendSignupCode,
    resetPasswordWithCode,
    signInWithPassword,
    signUpWithPassword,
    verifyEmailCode,
  } = createEmailAuthActions({
    resend: mockResend,
    resetPasswordForEmail: mockResetPasswordForEmail,
    signInWithPassword: mockSignInWithPassword,
    signOut: mockSignOut,
    signUp: mockSignUp,
    updateUser: mockUpdateUser,
    verifyOtp: mockVerifyOtp,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("normalizes email before signing in", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });

    await expect(
      signInWithPassword({
        email: "  Friend@Example.COM ",
        password: "password123",
      }),
    ).resolves.toEqual({ kind: "success" });

    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "friend@example.com",
      password: "password123",
    });
  });

  test("maps invalid credentials without revealing account details", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: new AuthError(
        "Invalid login credentials",
        400,
        "invalid_credentials",
      ),
    });

    await expect(
      signInWithPassword({
        email: "friend@example.com",
        password: "wrong-password",
      }),
    ).resolves.toEqual({
      kind: "error",
      message: "Email or password is incorrect.",
    });
  });

  test("routes an unconfirmed sign-up to email verification", async () => {
    mockSignUp.mockResolvedValue({
      data: { session: null, user: null },
      error: null,
    });

    await expect(
      signUpWithPassword({
        email: "friend@example.com",
        password: "password123",
      }),
    ).resolves.toEqual({
      kind: "success",
      nextStep: {
        kind: "verify-email",
        email: "friend@example.com",
      },
    });

    expect(mockSignUp).toHaveBeenCalledWith({
      email: "friend@example.com",
      password: "password123",
    });
  });

  test("verifies signup codes as email OTPs", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });

    await expect(
      verifyEmailCode(" Friend@Example.COM ", "123456"),
    ).resolves.toEqual({ kind: "success" });

    expect(mockVerifyOtp).toHaveBeenCalledWith({
      email: "friend@example.com",
      token: "123456",
      type: "email",
    });
  });

  test("resends signup confirmation codes", async () => {
    mockResend.mockResolvedValue({ error: null });

    await expect(resendSignupCode(" Friend@Example.COM ")).resolves.toEqual({
      kind: "success",
      message: "A new code is on its way.",
    });

    expect(mockResend).toHaveBeenCalledWith({
      email: "friend@example.com",
      type: "signup",
    });
  });

  test("maps expired verification codes to useful safe copy", async () => {
    mockVerifyOtp.mockResolvedValue({
      error: new AuthError(
        "Token has expired or is invalid",
        403,
        "otp_expired",
      ),
    });

    await expect(
      verifyEmailCode("friend@example.com", "000000"),
    ).resolves.toEqual({
      kind: "error",
      message:
        "That code is invalid or expired. Request a new one and try again.",
    });
  });

  test("requests password recovery with normalized email and safe copy", async () => {
    mockResetPasswordForEmail.mockResolvedValue({ error: null });

    await expect(requestPasswordReset(" Friend@Example.COM ")).resolves.toEqual(
      {
        kind: "success",
        message:
          "If an account exists for that email, a reset code is on its way.",
      },
    );

    expect(mockResetPasswordForEmail).toHaveBeenCalledWith(
      "friend@example.com",
    );
  });

  test("verifies a recovery code before updating the password", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    mockUpdateUser.mockResolvedValue({ error: null });

    await expect(
      resetPasswordWithCode(
        " Friend@Example.COM ",
        "123456",
        "new-password-123",
      ),
    ).resolves.toEqual({
      kind: "success",
      message: "Your password has been updated.",
    });

    expect(mockVerifyOtp).toHaveBeenCalledWith({
      email: "friend@example.com",
      token: "123456",
      type: "recovery",
    });
    expect(mockUpdateUser).toHaveBeenCalledWith({
      password: "new-password-123",
    });
  });

  test("removes the temporary recovery session when password update fails", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    mockUpdateUser.mockResolvedValue({
      error: new AuthError(
        "Password should be different",
        422,
        "same_password",
      ),
    });
    mockSignOut.mockResolvedValue({ error: null });

    await resetPasswordWithCode(
      "friend@example.com",
      "123456",
      "same-password-123",
    );

    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
