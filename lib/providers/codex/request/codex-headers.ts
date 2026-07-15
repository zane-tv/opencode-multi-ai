export type CreateCodexHeadersInput = {
  accessToken: string;
  accountId: string;
  organizationId?: string;
  promptCacheKey?: string;
};

/**
 * Build the Headers required by ChatGPT/Codex backend-api Responses.
 *
 * Always sets:
 * - Authorization: Bearer <accessToken>
 * - chatgpt-account-id
 * - OpenAI-Beta: responses=experimental
 * - originator: codex_cli_rs
 * - accept: text/event-stream
 *
 * Conditionally:
 * - conversation_id + session_id from promptCacheKey (else deleted)
 * - openai-organization when organizationId is set
 *
 * Always deletes `x-api-key` so a dummy SDK key cannot leak.
 *
 * Returns a fresh `Headers` instance (callers merge into RequestInit as needed).
 */
export function createCodexHeaders(input: CreateCodexHeadersInput): Headers {
  const headers = new Headers();

  headers.set("Authorization", `Bearer ${input.accessToken}`);
  headers.set("chatgpt-account-id", input.accountId);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("originator", "codex_cli_rs");
  headers.set("accept", "text/event-stream");

  if (input.promptCacheKey) {
    headers.set("conversation_id", input.promptCacheKey);
    headers.set("session_id", input.promptCacheKey);
  } else {
    headers.delete("conversation_id");
    headers.delete("session_id");
  }

  if (input.organizationId) {
    headers.set("openai-organization", input.organizationId);
  }

  headers.delete("x-api-key");

  return headers;
}
