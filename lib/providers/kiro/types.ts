import type { KiroAccountMetadata } from "../../core/schemas.js";

export type KiroAuthMethod = KiroAccountMetadata["authMethod"];
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface KiroAuthDetails {
  refresh: string;
  access: string;
  expires: number;
  authMethod: KiroAuthMethod;
  region: string;
  oidcRegion?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  email?: string;
  profileArn?: string;
}

export type CodeWhispererToolUse = {
  readonly input: Record<string, unknown>;
  readonly name: string;
  readonly toolUseId: string;
};

export type CodeWhispererToolResult = {
  readonly toolUseId: string;
  readonly content: readonly { readonly text?: string }[];
  readonly status?: string;
};

export type CodeWhispererTool = {
  readonly toolSpecification: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: { readonly json: Record<string, unknown> };
  };
};

export interface CodeWhispererMessage {
  readonly userInputMessage?: {
    readonly content: string;
    readonly modelId: string;
    readonly origin: string;
    readonly images?: readonly {
      readonly format: string;
      readonly source: { readonly bytes: Uint8Array };
    }[];
    readonly userInputMessageContext?: {
      readonly toolResults?: readonly CodeWhispererToolResult[];
      readonly tools?: readonly CodeWhispererTool[];
    };
  };
  readonly assistantResponseMessage?: {
    readonly content: string;
    readonly toolUses?: readonly CodeWhispererToolUse[];
  };
}

export interface CodeWhispererRequest {
  readonly conversationState: {
    readonly chatTriggerType: string;
    readonly conversationId: string;
    readonly history?: readonly CodeWhispererMessage[];
    readonly currentMessage: CodeWhispererMessage;
  };
  readonly profileArn?: string;
}

export interface ToolCall {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: string | Record<string, unknown>;
}

export interface ParsedResponse {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly stopReason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface SdkPreparedRequest {
  readonly conversationState: CodeWhispererRequest["conversationState"];
  readonly profileArn?: string;
  readonly effectiveModel: string;
  readonly conversationId: string;
  readonly region: string;
  readonly streaming: boolean;
  readonly effort?: Effort;
  readonly thinkingBudget?: number;
}
