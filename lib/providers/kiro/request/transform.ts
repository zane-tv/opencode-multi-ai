import { randomUUID } from "node:crypto";

import { isGpt56Model } from "../effort.js";
import { resolveKiroModel } from "../models.js";
import type {
  CodeWhispererMessage,
  CodeWhispererRequest,
  CodeWhispererTool,
  CodeWhispererToolResult,
  CodeWhispererToolUse,
  KiroAuthMethod,
} from "../types.js";
import {
  findOriginalToolCall,
  getContentText,
  mergeAdjacentMessages,
  repairToolPairs,
  sanitizeHistory,
  type OpenCodeMessage,
} from "../transformers/message-transformer.js";
import {
  convertToolsToCodeWhisperer,
  normalizeKiroToolName,
  type OpenCodeTool,
} from "../transformers/tool-transformer.js";
import {
  buildAssistantResponse,
  buildHistory,
  buildToolResults,
  extractToolNamesFromHistory,
  historyHasToolCalling,
  injectSystemPrompt,
  normalizeToolUse,
} from "./history-builder.js";
import { extractKiroContent } from "./image-handler.js";

export type BuildCodeWhispererRequestParams = {
  readonly messages: readonly OpenCodeMessage[];
  readonly tools?: readonly OpenCodeTool[];
  readonly system?: string;
  readonly modelId: string;
  readonly thinking: boolean;
  readonly thinkingBudget?: number;
  readonly profileArn?: string;
  readonly authMethod: KiroAuthMethod;
  readonly conversationId?: string;
};

type MutableContext = {
  toolResults?: CodeWhispererToolResult[];
  tools?: CodeWhispererTool[];
};

function combineSystemPrompt(
  messages: readonly OpenCodeMessage[],
  system: string | undefined,
): string {
  const embedded = messages
    .filter((message) => message.role === "system")
    .map((message) => getContentText(message))
    .filter(Boolean)
    .join("\n\n");
  return [system, embedded].filter(Boolean).join("\n\n");
}

function addPreviousAssistantText(
  history: CodeWhispererMessage[],
  messages: readonly OpenCodeMessage[],
): void {
  const current = messages.at(-1);
  const previous = messages.at(-2);
  if (current?.role !== "user" || previous?.role !== "assistant") return;
  if (!history.at(-1)?.userInputMessage) return;
  const content = getContentText(previous);
  if (content) history.push({ assistantResponseMessage: { content } });
}

function partitionToolResults(
  results: readonly CodeWhispererToolResult[],
  history: CodeWhispererMessage[],
  messages: readonly OpenCodeMessage[],
): {
  readonly matched: CodeWhispererToolResult[];
  readonly orphaned: readonly {
    readonly call: CodeWhispererToolUse;
    readonly result: CodeWhispererToolResult;
  }[];
  readonly unmatchedText: string;
} {
  const historyIds = new Set(
    history.flatMap((message) =>
      (message.assistantResponseMessage?.toolUses ?? []).map((toolUse) => toolUse.toolUseId),
    ),
  );
  const matched: CodeWhispererToolResult[] = [];
  const orphaned: Array<{ call: CodeWhispererToolUse; result: CodeWhispererToolResult }> = [];
  let unmatchedText = "";
  for (const result of results) {
    if (historyIds.has(result.toolUseId)) {
      matched.push(result);
      continue;
    }
    const original = findOriginalToolCall(messages, result.toolUseId);
    const call = normalizeToolUse(original);
    if (call) {
      orphaned.push({ call, result });
      continue;
    }
    unmatchedText += `\n\n[Output for tool call ${result.toolUseId}]:\n${result.content[0]?.text ?? ""}`;
  }
  return { matched, orphaned, unmatchedText };
}

function addOrphanedToolHistory(
  history: CodeWhispererMessage[],
  orphaned: readonly {
    readonly call: CodeWhispererToolUse;
    readonly result: CodeWhispererToolResult;
  }[],
  modelId: string,
): void {
  if (orphaned.length === 0) return;
  if (!history.at(-1)?.userInputMessage) {
    history.push({
      userInputMessage: { content: "Running tools...", modelId, origin: "AI_EDITOR" },
    });
  }
  history.push({
    assistantResponseMessage: {
      content: "I will execute the following tools.",
      toolUses: orphaned.map((entry) => entry.call),
    },
  });
}

function addMissingHistoryTools(
  context: MutableContext,
  history: readonly CodeWhispererMessage[],
): void {
  if (!historyHasToolCalling(history)) return;
  const historyNames = extractToolNamesFromHistory(history);
  const existing = context.tools ?? [];
  const existingNames = new Set(existing.map((tool) => tool.toolSpecification.name));
  const missing = [...historyNames].filter((name) => !existingNames.has(name));
  if (missing.length === 0) return;
  const used = new Set(existingNames);
  context.tools = [
    ...existing,
    ...missing.map((name) => ({
      toolSpecification: {
        name: normalizeKiroToolName(name, used),
        description: "Tool",
        inputSchema: { json: { type: "object", properties: {} } },
      },
    })),
  ];
}

export function buildCodeWhispererRequest(
  params: BuildCodeWhispererRequestParams,
): CodeWhispererRequest {
  const modelId = resolveKiroModel(params.modelId);
  if (params.messages.length === 0) throw new Error("No messages");
  const conversationId = params.conversationId ?? randomUUID();
  let system = combineSystemPrompt(params.messages, params.system);
  if (params.thinking && !isGpt56Model(modelId) && !system.includes("<thinking_mode>")) {
    const budget = params.thinkingBudget ?? 20_000;
    const prefix = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
    system = system ? `${prefix}\n${system}` : prefix;
  }

  const nonSystemMessages = params.messages.filter((message) => message.role !== "system");
  const repaired = repairToolPairs(nonSystemMessages);
  const merged = mergeAdjacentMessages(repaired);
  const messages = merged.at(-1)?.role === "assistant" && getContentText(merged.at(-1)) === "{"
    ? merged.slice(0, -1)
    : merged;
  const current = messages.at(-1);
  if (!current) throw new Error("Empty messages");

  let history = sanitizeHistory(buildHistory(messages, modelId));
  addPreviousAssistantText(history, messages);
  history = sanitizeHistory(injectSystemPrompt(history, system, modelId));
  const tools = params.tools ? convertToolsToCodeWhisperer(params.tools) : [];
  const context: MutableContext = {};
  let content = "";
  let images = extractKiroContent(current.content).images;

  if (current.role === "assistant") {
    const assistant = buildAssistantResponse(current);
    if (assistant) history.push({ assistantResponseMessage: assistant });
    content = "[system: conversation continues]";
    images = [];
  } else {
    const previous = history.at(-1);
    if (previous && !previous.assistantResponseMessage) {
      history.push({
        assistantResponseMessage: { content: "[system: conversation continues]" },
      });
    }
    const extracted = extractKiroContent(current.content);
    content = extracted.text;
    images = extracted.images;
    const results = buildToolResults(current);
    const partitioned = partitionToolResults(results, history, params.messages);
    addOrphanedToolHistory(history, partitioned.orphaned, modelId);
    history = sanitizeHistory(history);
    const toolResults = [
      ...partitioned.matched,
      ...partitioned.orphaned.map((entry) => entry.result),
    ];
    if (toolResults.length > 0) context.toolResults = toolResults;
    content += partitioned.unmatchedText;
    if (!content) {
      content = results.length > 0 ? "Tool results provided." : "[system: conversation continues]";
    }
  }

  if (tools.length > 0) context.tools = tools;
  addMissingHistoryTools(context, history);
  const hasContext = (context.toolResults?.length ?? 0) > 0 || (context.tools?.length ?? 0) > 0;
  const currentMessage: CodeWhispererMessage = {
    userInputMessage: {
      content,
      modelId,
      origin: "AI_EDITOR",
      ...(images.length > 0 ? { images } : {}),
      ...(hasContext ? { userInputMessageContext: context } : {}),
    },
  };
  const conversationState = {
    chatTriggerType: "MANUAL",
    conversationId,
    ...(history.length > 0 ? { history } : {}),
    currentMessage,
  };
  return params.profileArn && params.authMethod !== "api-key"
    ? { conversationState, profileArn: params.profileArn }
    : { conversationState };
}
