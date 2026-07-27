import { AuthError } from "@supabase/supabase-js";

import { createPasswordAuthActions } from "@/features/auth/auth-action-factory";

const mockSignInWithPassword = jest.fn();
const mockSignUp = jest.fn();

describe("Auth actions", () => {
  const { signInWithPassword, signUpWithPassword } = createPasswordAuthActions({
    signInWithPassword: mockSignInWithPassword,
    signUp: mockSignUp,
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

  test("uses generic confirmation copy after unconfirmed sign-up", async () => {
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
      message:
        "Check your email to confirm your account, then return to Orca to sign in.",
    });
  });
});
