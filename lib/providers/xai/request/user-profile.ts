/**
 * SuperGrok user profile (email) from cli-chat-proxy.
 * JWT often lacks email; this fills AccountMetadata.email for display.
 */

export const GROK_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";

export type GrokUserProfile = {
  email?: string;
  userId?: string;
  firstName?: string;
  lastName?: string;
};

export async function fetchGrokUserProfile(
  accessToken: string,
): Promise<GrokUserProfile> {
  const res = await fetch(GROK_USER_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "user-agent": "opencode-multi-ai",
    },
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 120);
    throw new Error(
      `user profile HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  const body = (await res.json()) as Record<string, unknown>;
  const email =
    typeof body["email"] === "string" && body["email"].trim()
      ? body["email"].trim()
      : undefined;
  const userId =
    typeof body["userId"] === "string" ? body["userId"] : undefined;
  const firstName =
    typeof body["firstName"] === "string" ? body["firstName"] : undefined;
  const lastName =
    typeof body["lastName"] === "string" ? body["lastName"] : undefined;
  return { email, userId, firstName, lastName };
}
