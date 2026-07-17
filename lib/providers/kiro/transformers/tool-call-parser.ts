export type ParsedKiroToolCall = {
  name: string;
  input: Record<string, unknown>;
};

export function parseBracketToolCalls(content: string): ParsedKiroToolCall[] {
  const calls: ParsedKiroToolCall[] = [];
  const expression = /\[TOOL_CALL\]\s*([^\s\]]+)\s*(\{[\s\S]*?\})\s*\[\/TOOL_CALL\]/g;
  for (const match of content.matchAll(expression)) {
    const name = match[1];
    const payload = match[2];
    if (!name || !payload) continue;
    try {
      const value: unknown = JSON.parse(payload);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        calls.push({ name, input: value as Record<string, unknown> });
      }
    } catch {
      continue;
    }
  }
  return calls;
}
