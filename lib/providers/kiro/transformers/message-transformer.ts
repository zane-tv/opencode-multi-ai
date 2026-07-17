import type { CodeWhispererMessage } from "../types.js";

export type OpenCodeMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; [key: string]: unknown }>;
  tool_call_id?: string;
  tool_results?: Array<{ content?: unknown; tool_call_id?: string }>;
  [key: string]: unknown;
};

function copyMessage(message: OpenCodeMessage): OpenCodeMessage {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? [...message.content]
      : message.content,
    tool_calls: message.tool_calls ? [...message.tool_calls] : undefined,
    tool_results: message.tool_results
      ? [...message.tool_results]
      : undefined,
  };
}

function toolUseIdsFromMessage(message: OpenCodeMessage): string[] {
  const ids: string[] = [];
  for (const call of message.tool_calls ?? []) {
    if (typeof call.id === "string" && call.id) ids.push(call.id);
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (
        part !== null &&
        typeof part === "object" &&
        "type" in part &&
        (part as { type?: unknown }).type === "tool_use"
      ) {
        const id = (part as { id?: unknown }).id;
        if (typeof id === "string" && id) ids.push(id);
      }
    }
  }
  return ids;
}

function toolResultIdsFromMessage(message: OpenCodeMessage): string[] {
  const ids: string[] = [];
  if (typeof message.tool_call_id === "string" && message.tool_call_id) {
    ids.push(message.tool_call_id);
  }
  for (const result of message.tool_results ?? []) {
    if (typeof result.tool_call_id === "string" && result.tool_call_id) {
      ids.push(result.tool_call_id);
    }
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (
        part !== null &&
        typeof part === "object" &&
        "type" in part &&
        (part as { type?: unknown }).type === "tool_result"
      ) {
        const id =
          (part as { tool_use_id?: unknown }).tool_use_id ??
          (part as { tool_call_id?: unknown }).tool_call_id;
        if (typeof id === "string" && id) ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Ensure every assistant tool_use has a following tool_result.
 * Missing results are synthesized so Claude/Kiro reject unpaired tool_use.
 */
export function repairToolPairs(
  messages: readonly OpenCodeMessage[],
): OpenCodeMessage[] {
  const out: OpenCodeMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    out.push(copyMessage(message));
    if (message.role !== "assistant") continue;

    const needed = toolUseIdsFromMessage(message);
    if (needed.length === 0) continue;

    const found = new Set<string>();
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j]!;
      if (next.role === "tool") {
        for (const id of toolResultIdsFromMessage(next)) found.add(id);
        continue;
      }
      if (next.role === "user") {
        const resultIds = toolResultIdsFromMessage(next);
        if (resultIds.length > 0) {
          for (const id of resultIds) found.add(id);
          continue;
        }
      }
      break;
    }

    for (const id of needed) {
      if (found.has(id)) continue;
      out.push({
        role: "tool",
        tool_call_id: id,
        content: "Tool was interrupted or result missing.",
      });
    }
  }
  return out;
}

export function mergeAdjacentMessages(
  messages: readonly OpenCodeMessage[],
): OpenCodeMessage[] {
  const merged: OpenCodeMessage[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (!last || message.role !== last.role) {
      merged.push(copyMessage(message));
      continue;
    }
    if (typeof last.content === "string" && typeof message.content === "string") {
      last.content = `${last.content}\n${message.content}`;
    } else if (Array.isArray(last.content) && Array.isArray(message.content)) {
      last.content.push(...message.content);
    } else if (Array.isArray(last.content) && typeof message.content === "string") {
      last.content.push({ type: "text", text: message.content });
    } else if (typeof last.content === "string" && Array.isArray(message.content)) {
      last.content = [{ type: "text", text: last.content }, ...message.content];
    }
    if (message.tool_calls) {
      last.tool_calls = [...(last.tool_calls ?? []), ...message.tool_calls];
    }
    if (message.role === "tool") {
      if (!last.tool_results) {
        last.tool_results = [
          {
            content: last.content,
            tool_call_id:
              typeof last.tool_call_id === "string"
                ? last.tool_call_id
                : undefined,
          },
        ];
      }
      last.tool_results.push({
        content: message.content,
        tool_call_id:
          typeof message.tool_call_id === "string"
            ? message.tool_call_id
            : undefined,
      });
    }
  }
  return merged;
}

export function getContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return "";
  const message = value as { content?: unknown; text?: unknown };
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(
        (part): part is { type: string; text?: unknown } =>
          part !== null && typeof part === "object" && "type" in part,
      )
      .filter((part) => part.type === "text")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return typeof message.text === "string" ? message.text : "";
}

export function findOriginalToolCall(
  messages: readonly OpenCodeMessage[],
  toolUseId: string,
): { id?: string; [key: string]: unknown } | undefined {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const match = message.tool_calls?.find((call) => call.id === toolUseId);
    if (match) return match;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          part !== null &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "tool_use" &&
          (part as { id?: unknown }).id === toolUseId
        ) {
          return part as { id?: string; [key: string]: unknown };
        }
      }
    }
  }
  return undefined;
}

/**
 * Drop unpaired tool_use / tool_result turns from CodeWhisperer history.
 * Trailing assistant toolUses are kept — currentMessage may supply results.
 */
export function sanitizeHistory(
  history: readonly CodeWhispererMessage[],
): CodeWhispererMessage[] {
  const result: CodeWhispererMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (!message) continue;

    if (message.assistantResponseMessage?.toolUses?.length) {
      const next = history[i + 1];
      if (next?.userInputMessage?.userInputMessageContext?.toolResults?.length) {
        result.push(message);
      } else if (i === history.length - 1) {
        result.push(message);
      } else {
        const content = message.assistantResponseMessage.content;
        if (content) {
          result.push({ assistantResponseMessage: { content } });
        }
      }
      continue;
    }

    if (message.userInputMessage?.userInputMessageContext?.toolResults?.length) {
      const prev = result.at(-1);
      if (prev?.assistantResponseMessage?.toolUses?.length) {
        result.push(message);
      }
      continue;
    }

    result.push(message);
  }

  while (result.length > 0) {
    const first = result[0];
    if (
      first?.userInputMessage &&
      !first.userInputMessage.userInputMessageContext?.toolResults?.length
    ) {
      break;
    }
    if (first?.assistantResponseMessage && !first.userInputMessage) {
      result.shift();
      continue;
    }
    if (first?.userInputMessage?.userInputMessageContext?.toolResults?.length) {
      result.shift();
      continue;
    }
    break;
  }

  return result;
}
