export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
  functionCall?: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiGenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  thinkingConfig?: {
    thinkingBudget?: number;
    includeThoughts?: boolean;
  };
}

export interface GeminiInternalPayload {
  project: string;
  model: string;
  userAgent: string;
  requestType: string;
  requestId: string;
  request: {
    systemInstruction?: {
      parts: GeminiPart[];
    };
    contents: GeminiContent[];
    tools?: GeminiTool[];
    generationConfig?: GeminiGenerationConfig;
    sessionId?: string;
    toolConfig?: {
      functionCallingConfig?: {
        mode: "AUTO" | "ANY" | "NONE" | "VALIDATED";
      };
    };
  };
}

export interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
    role?: string;
  };
  finishReason?: string;
  index?: number;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiSseResponsePayload {
  response?: {
    candidates?: GeminiCandidate[];
    usageMetadata?: GeminiUsageMetadata;
  };
}
