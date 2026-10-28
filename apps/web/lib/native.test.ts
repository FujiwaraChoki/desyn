import { describe, expect, it } from "vitest";
import { parseNativeRequest } from "./native";

const challenge = "a".repeat(43);

describe("parseNativeRequest", () => {
  it("accepts the app scheme and loopback redirects", () => {
    expect(
      parseNativeRequest({
        client: "desktop",
        redirect_uri: "desyn://auth/callback",
        code_challenge: challenge,
        state: "s1",
      }),
    ).toEqual({
      client: "desktop",
      redirectUri: "desyn://auth/callback",
      codeChallenge: challenge,
      state: "s1",
    });
    expect(
      parseNativeRequest({
        client: "cli",
        redirect_uri: "http://127.0.0.1:53682/cb",
        code_challenge: challenge,
      })?.client,
    ).toBe("cli");
  });
  it("rejects anything else", () => {
    expect(
      parseNativeRequest({ client: "web", redirect_uri: "desyn://x", code_challenge: challenge }),
    ).toBeNull();
    expect(
      parseNativeRequest({
        client: "ios",
        redirect_uri: "https://evil.test/cb",
        code_challenge: challenge,
      }),
    ).toBeNull();
    expect(
      parseNativeRequest({
        client: "ios",
        redirect_uri: "http://evil.test/cb",
        code_challenge: challenge,
      }),
    ).toBeNull();
    expect(
      parseNativeRequest({ client: "ios", redirect_uri: "desyn://x", code_challenge: "short" }),
    ).toBeNull();
    expect(
      parseNativeRequest({
        client: "ios",
        redirect_uri: "desyn://x",
        code_challenge: challenge,
        code_challenge_method: "plain",
      }),
    ).toBeNull();
  });
});
