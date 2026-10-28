/** /native/authorize request parsing (shared by the server page and tests; no client directive). */

export type NativeClient = "desktop" | "ios" | "cli";

export interface NativeRequest {
  client: NativeClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
}

/** Parses and sanity-checks the query of /native/authorize (the server re-validates everything). */
export function parseNativeRequest(params: {
  client?: string | undefined;
  redirect_uri?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
  state?: string | undefined;
}): NativeRequest | null {
  const client = params.client;
  if (client !== "desktop" && client !== "ios" && client !== "cli") return null;
  if (!params.redirect_uri || !params.code_challenge) return null;
  if (params.code_challenge_method && params.code_challenge_method !== "S256") return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) return null;
  try {
    const url = new URL(params.redirect_uri);
    if (!["desyn:", "http:"].includes(url.protocol)) return null;
    if (url.protocol === "http:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      return null;
  } catch {
    return null;
  }
  return {
    client,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    state: params.state && params.state.length <= 512 ? params.state : null,
  };
}
