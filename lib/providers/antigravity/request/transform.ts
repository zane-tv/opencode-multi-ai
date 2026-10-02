import crypto from "node:crypto";
import type {
  GeminiContent,
  GeminiGenerationConfig,
  GeminiInternalPayload,
  GeminiPart,
  GeminiTool,
} from "../types.js";
import { cleanJSONSchemaForAntigravity, sanitizeFunctionName } from "./clean-schema.js";
import { ANTIGRAVITY_DEFAULT_MODELS, DEFAULT_THINKING_AG_SIGNATURE } from "../constants.js";

export interface OpenAiToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

export interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAiRequestBody {
  model?: string;
  messages?: OpenAiMessage[];
  tools?: OpenAiTool[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  sessionId?: string;
  [key: string]: unknown;
}

function extractText(content: OpenAiMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function resolveInternalModel(
  modelName?: string,
  effort?: string,
): {
  internalModel: string;
  thinkingBudget?: number;
} {
  const raw = (modelName || "gemini-3-flash")
    .replace(/^(antigravity-multi\/|antigravity\/|ag\/)/, "")
    .toLowerCase();

  let customBudget: number | undefined;
  if (effort === "low") customBudget = 1024;
  else if (effort === "medium") customBudget = 4096;
  else if (effort === "high") customBudget = 8192;

  // 1. Claude Opus (explicit or fuzzy match)
  if (raw.includes("opus")) {
    return { internalModel: "claude-opus-4-6-thinking", thinkingBudget: customBudget ?? 8192 };
  }

  // 2. Claude Sonnet or any other Claude reference
  if (raw.includes("sonnet") || raw.includes("claude")) {
    return { internalModel: "claude-sonnet-4-6", thinkingBudget: customBudget ?? 4096 };
  }

  // 3. Open weights / GPT-OSS
  if (raw.includes("gpt-oss") || raw.includes("oss")) {
    return { internalModel: "gpt-oss-120b-medium", thinkingBudget: customBudget ?? 4096 };
  }

  // 4. Gemini Pro flagship models
  if (raw.includes("pro") || raw.includes("3.1")) {
    return { internalModel: "gemini-3.1-pro-low", thinkingBudget: customBudget ?? 4096 };
  }

  // 5. Zero-thinking Flash (instant command/edit execution)
  if (
    raw === "gemini-3-flash" ||
    raw === "gemini-flash" ||
    raw.includes("zero") ||
    raw.includes("instant") ||
    raw.includes("command")
  ) {
    return { internalModel: "gemini-3-flash", thinkingBudget: 0 };
  }

  // 6. Gemini 3.8 Flash High (Deep Reasoning)
  if (
    raw === "gemini-3.8-flash-high" ||
    (raw.includes("3.8") && !raw.includes("low")) ||
    (raw.includes("flash") && raw.includes("high")) ||
    raw.includes("agent")
  ) {
    return { internalModel: "gemini-3.6-flash-high", thinkingBudget: customBudget ?? 8192 };
  }

  // 7. Gemini 3.7 Flash Medium (Balanced)
  if (raw.includes("3.7") || (raw.includes("flash") && raw.includes("medium"))) {
    return { internalModel: "gemini-3.6-flash-low", thinkingBudget: customBudget ?? 4096 };
  }

  // 8. Gemini 3.6 Flash (Fast / Light Reasoning)
  if (raw.includes("3.6") || (raw.includes("flash") && raw.includes("low"))) {
    return { internalModel: "gemini-3.6-flash-low", thinkingBudget: customBudget ?? 2048 };
  }

  // 9. Generic Flash fallback
  if (raw.includes("flash")) {
    return { internalModel: "gemini-3-flash", thinkingBudget: 0 };
  }

  // Default fallback for unknown model: default to deep reasoning Gemini rather than downgrading
  return { internalModel: "gemini-3.6-flash-high", thinkingBudget: customBudget ?? 8192 };
}

const AGENT_CODE_REVIEW_PROMPT =
  "Core Principles for Deep Reasoning, Architecture & Code Review:\n" +
  "1. Deep Thinking & Root Cause: Always reason deeply about problems before generating solutions. Identify root causes, architectural constraints, and side-effects across the codebase.\n" +
  "2. Comprehensive Code Navigation: Avoid repeated micro-reads (reading 20-50 lines repeatedly). Read complete functions, classes, or files once to understand full scope, call-graphs, and dependencies before proposing edits.\n" +
  "3. Spec-Driven Planning: For multi-file changes or refactors, break tasks down into layer-by-layer architectural steps with explicit risk analysis and verification test plans.\n" +
  "4. Strict Code Quality & Safety: Zero resource leaks (dispose streams/timers/controllers), enforce null safety, async/concurrency correctness, and clean error handling. Never swallow errors with empty catch blocks.\n" +
  "5. Responsive & Resilient UI: Ensure layout safety (prevent RenderFlex overflows), keep components modular, and use modern idiomatic patterns.";

export function transformOpenAiToGemini(
  body: OpenAiRequestBody,
  options: {
    projectId: string;
    sessionId?: string;
  },
): GeminiInternalPayload {
  const rawModel = body.model || "gemini-3-flash";
  const reasoningEffort =
    typeof body.reasoning_effort === "string"
      ? body.reasoning_effort
      : undefined;
  const { internalModel, thinkingBudget } = resolveInternalModel(rawModel, reasoningEffort);
  const mappedModelName = internalModel;

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const contents: GeminiContent[] = [];

  // Extract system prompt if present
  let systemText = "";
  const filteredMessages: OpenAiMessage[] = [];
  for (const msg of rawMessages) {
    if (msg.role === "system") {
      const txt = extractText(msg.content);
      if (txt) {
        systemText = systemText ? `${systemText}\n\n${txt}` : txt;
      }
    } else {
      filteredMessages.push(msg);
    }
  }

  const toolCallIdToName = new Map<string, string>();

  for (let i = 0; i < filteredMessages.length; i++) {
    const msg = filteredMessages[i];
    const parts: GeminiPart[] = [];

    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item && typeof item === "object") {
            const it = item as Record<string, unknown>;
            if (it.type === "tool_result") {
              const callId = (it.tool_use_id as string) || (it.id as string);
              const fnName = (callId ? toolCallIdToName.get(callId) : undefined) || "tool";
              let resp: Record<string, unknown>;
              if (typeof it.content === "object" && it.content !== null && !Array.isArray(it.content)) {
                resp = it.content as Record<string, unknown>;
              } else {
                resp = { result: typeof it.content === "string" ? it.content : JSON.stringify(it.content) };
              }
              parts.push({
                functionResponse: {
                  id: callId,
                  name: sanitizeFunctionName(fnName),
                  response: resp,
                },
              });
            } else if (it.type === "text" && typeof it.text === "string" && it.text) {
              parts.push({ text: it.text });
            }
          }
        }
      } else {
        const txt = extractText(msg.content);
        if (txt) parts.push({ text: txt });
      }
      if (parts.length === 0) parts.push({ text: " " });
      contents.push({ role: "user", parts });
    } else if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item && typeof item === "object") {
            const it = item as Record<string, unknown>;
            if (it.type === "text" && typeof it.text === "string" && it.text) {
              parts.push({ text: it.text });
            } else if (it.type === "tool_use") {
              const callId = (it.id as string) || `call_${crypto.randomBytes(6).toString("hex")}`;
              const fnName = (it.name as string) || "tool";
              toolCallIdToName.set(callId, fnName);
              const args = (typeof it.input === "object" && it.input !== null ? it.input : {}) as Record<string, unknown>;
              parts.push({
                thoughtSignature: DEFAULT_THINKING_AG_SIGNATURE,
                thought_signature: DEFAULT_THINKING_AG_SIGNATURE,
                functionCall: {
                  id: callId,
                  name: sanitizeFunctionName(fnName),
                  args,
                },
              });
            }
          }
        }
      } else {
        const txt = extractText(msg.content);
        if (txt) parts.push({ text: txt });
      }

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const callId = tc.id || `call_${crypto.randomBytes(6).toString("hex")}`;
          if (tc.function?.name) {
            toolCallIdToName.set(callId, tc.function.name);
          }
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = { raw: tc.function.arguments };
          }
          parts.push({
            thoughtSignature: DEFAULT_THINKING_AG_SIGNATURE,
            thought_signature: DEFAULT_THINKING_AG_SIGNATURE,
            functionCall: {
              id: callId,
              name: sanitizeFunctionName(tc.function.name),
              args,
            },
          });
        }
      }
      if (parts.length === 0) parts.push({ text: " " });
      contents.push({ role: "model", parts });
    } else if (msg.role === "tool") {
      const txt = extractText(msg.content);
      let responseObj: Record<string, unknown>;
      try {
        responseObj = JSON.parse(txt);
        if (typeof responseObj !== "object" || responseObj === null || Array.isArray(responseObj)) {
          responseObj = { result: txt };
        }
      } catch {
        responseObj = { result: txt };
      }

      const callId = msg.tool_call_id || (msg as { id?: string }).id;
      const fnName =
        msg.name ||
        (callId ? toolCallIdToName.get(callId) : undefined) ||
        "tool";

      parts.push({
        functionResponse: {
          id: callId,
          name: sanitizeFunctionName(fnName),
          response: responseObj,
        },
      });
      // Tool responses in Gemini have role "user"
      contents.push({ role: "user", parts });
    }
  }

  // Merge consecutive same-role contents
  const mergedContents: GeminiContent[] = [];
  for (const c of contents) {
    const prev = mergedContents[mergedContents.length - 1];
    if (prev && prev.role === c.role) {
      prev.parts.push(...c.parts);
    } else {
      mergedContents.push({ role: c.role, parts: [...c.parts] });
    }
  }

  // Transform tools
  let geminiTools: GeminiTool[] | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const declarations = body.tools.map((t) => ({
      name: sanitizeFunctionName(t.function.name),
      description: t.function.description || "",
      parameters: cleanJSONSchemaForAntigravity(t.function.parameters || {}),
    }));
    geminiTools = [{ functionDeclarations: declarations }];
  }

  const generationConfig: GeminiGenerationConfig = {
    maxOutputTokens: 65536,
  };
  if (typeof body.temperature === "number") {
    generationConfig.temperature = body.temperature;
  }
  if (thinkingBudget !== undefined) {
    if (thinkingBudget === 0) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    } else {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget,
      };
    }
  }

  const sessionId = options.sessionId || body.sessionId || crypto.randomUUID();
  const fullSystem = systemText
    ? `${AGENT_CODE_REVIEW_PROMPT}\n\n${systemText}`
    : AGENT_CODE_REVIEW_PROMPT;

  return {
    project: options.projectId,
    model: mappedModelName,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent-${crypto.randomUUID()}`,
    request: {
      systemInstruction: {
        parts: [{ text: fullSystem }],
      },
      contents: mergedContents,
      ...(geminiTools ? { tools: geminiTools } : {}),
      generationConfig,
      sessionId,
      ...(geminiTools && geminiTools.length > 0
        ? { toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } }
        : {}),
    },
  };
}
