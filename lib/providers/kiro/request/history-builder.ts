import { extractKiroContent } from "./image-handler.js";
import {
  getContentText,
  type OpenCodeMessage,
} from "../transformers/message-transformer.js";
import {
  normalizeKiroToolInput,
  normalizeKiroToolName,
  normalizeKiroToolUseId,
} from "../transformers/tool-transformer.js";
import type {
  CodeWhispererMessage,
  CodeWhispererToolResult,
  CodeWhispererToolUse,
} from "../types.js";

type AssistantResponse = NonNullable<CodeWhispererMessage["assistantResponseMessage"]>;
type UserInput = NonNullable<CodeWhispererMessage["userInputMessage"]>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeToolUse(value: unknown): CodeWhispererToolUse | undefined {
  const call = record(value);
  if (!call) return undefined;
  const fn = record(call.function);
  const name = text(call.name) ?? text(fn?.name) ?? "tool";
  const toolUseId = text(call.toolUseId) ?? text(call.id) ?? "tool";
  const input = call.input ?? fn?.arguments;
  return {
    name: normalizeKiroToolName(name),
    toolUseId: normalizeKiroToolUseId(toolUseId),
    input: normalizeKiroToolInput(input),
  };
}

function toolResult(value: unknown, fallbackId: string): CodeWhispererToolResult {
  const item = record(value);
  const toolUseId = text(item?.tool_use_id) ?? text(item?.tool_call_id) ?? fallbackId;
  const content = item?.content ?? value;
  return {
    content: [{ text: getContentText(content) }],
    status: "success",
    toolUseId: normalizeKiroToolUseId(toolUseId),
  };
}

export function deduplicateToolResults(
  results: readonly CodeWhispererToolResult[],
): CodeWhispererToolResult[] {
  const seen = new Set<string>();
  const unique: CodeWhispererToolResult[] = [];
  for (const result of results) {
    const toolUseId = normalizeKiroToolUseId(result.toolUseId);
    if (seen.has(toolUseId)) continue;
    seen.add(toolUseId);
    unique.push({ ...result, toolUseId });
  }
  return unique;
}

export function buildToolResults(message: OpenCodeMessage): CodeWhispererToolResult[] {
  const results: CodeWhispererToolResult[] = [];
  if (message.role === "tool") {
    if (Array.isArray(message.tool_results)) {
      for (const result of message.tool_results) {
        const item = record(result);
        results.push(toolResult(result, text(item?.tool_call_id) ?? "tool"));
      }
    } else {
      results.push(toolResult(message, message.tool_call_id ?? "tool"));
    }
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (record(part)?.type === "tool_result") results.push(toolResult(part, "tool"));
    }
  }
  return deduplicateToolResults(results);
}

export function buildAssistantResponse(
  message: OpenCodeMessage,
): AssistantResponse | undefined {
  let content = "";
  let thinking = "";
  const toolUses: CodeWhispererToolUse[] = [];
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const item = record(part);
      if (!item) continue;
      if (item.type === "text") content += text(item.text) ?? "";
      if (item.type === "thinking") thinking += text(item.thinking) ?? text(item.text) ?? "";
      if (item.type === "tool_use") {
        const normalized = normalizeToolUse(item);
        if (normalized) toolUses.push(normalized);
      }
    }
  } else {
    content = getContentText(message);
  }
  for (const call of message.tool_calls ?? []) {
    const normalized = normalizeToolUse(call);
    if (normalized) toolUses.push(normalized);
  }
  if (thinking) {
    content = content
      ? `<thinking>${thinking}</thinking>\n\n${content}`
      : `<thinking>${thinking}</thinking>`;
  }
  if (!content && toolUses.length === 0) return undefined;
  return { content, ...(toolUses.length > 0 ? { toolUses } : {}) };
}

function userInput(message: OpenCodeMessage, modelId: string): UserInput {
  const extracted = extractKiroContent(message.content);
  const toolResults = buildToolResults(message);
  return {
    content: message.role === "tool" ? "Tool results provided." : extracted.text,
    modelId,
    origin: "AI_EDITOR",
    ...(extracted.images.length > 0 ? { images: extracted.images } : {}),
    ...(toolResults.length > 0 ? { userInputMessageContext: { toolResults } } : {}),
  };
}

function mergeAssistant(previous: AssistantResponse, current: AssistantResponse): AssistantResponse {
  const content = current.content
    ? previous.content
      ? `${previous.content}\n\n${current.content}`
      : current.content
    : previous.content;
  const toolUses = [...(previous.toolUses ?? []), ...(current.toolUses ?? [])];
  return { content, ...(toolUses.length > 0 ? { toolUses } : {}) };
}

export function buildHistory(
  messages: readonly OpenCodeMessage[],
  modelId: string,
): CodeWhispererMessage[] {
  const history: CodeWhispererMessage[] = [];
  for (const message of messages.slice(0, -1)) {
    if (message.role === "user" || message.role === "tool") {
      if (history.at(-1)?.userInputMessage) {
        history.push({
          assistantResponseMessage: { content: "[system: conversation continues]" },
        });
      }
      history.push({ userInputMessage: userInput(message, modelId) });
      continue;
    }
    if (message.role !== "assistant") continue;
    const current = buildAssistantResponse(message);
    if (!current) continue;
    const previous = history.at(-1)?.assistantResponseMessage;
    if (previous) {
      history[history.length - 1] = { assistantResponseMessage: mergeAssistant(previous, current) };
    } else {
      history.push({ assistantResponseMessage: current });
    }
  }
  return history;
}

export function injectSystemPrompt(
  history: readonly CodeWhispererMessage[],
  system: string | undefined,
  modelId: string,
): CodeWhispererMessage[] {
  if (!system) return [...history];
  const index = history.findIndex((message) => message.userInputMessage !== undefined);
  if (index === -1) {
    return [
      { userInputMessage: { content: system, modelId, origin: "AI_EDITOR" } },
      ...history,
    ];
  }
  return history.map((message, messageIndex) => {
    if (messageIndex !== index || !message.userInputMessage) return message;
    return {
      userInputMessage: {
        ...message.userInputMessage,
        content: `${system}\n\n${message.userInputMessage.content}`,
      },
    };
  });
}

export function historyHasToolCalling(history: readonly CodeWhispererMessage[]): boolean {
  return history.some(
    (message) =>
      (message.assistantResponseMessage?.toolUses?.length ?? 0) > 0 ||
      (message.userInputMessage?.userInputMessageContext?.toolResults?.length ?? 0) > 0,
  );
}

export function extractToolNamesFromHistory(
  history: readonly CodeWhispererMessage[],
): Set<string> {
  const names = new Set<string>();
  for (const message of history) {
    for (const toolUse of message.assistantResponseMessage?.toolUses ?? []) {
      names.add(toolUse.name);
    }
  }
  return names;
}
