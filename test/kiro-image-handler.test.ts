import { describe, expect, it } from "vitest";

import { extractKiroContent } from "../lib/providers/kiro/request/image-handler.js";

describe("Kiro image handling", () => {
  it("preserves text and converts data-url images", () => {
    const content = extractKiroContent([
      { type: "text", text: "hello" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
      { type: "text", text: " world" },
    ]);
    expect(content.text).toBe("hello world");
    expect(content.images).toHaveLength(1);
    expect(content.images[0]?.format).toBe("png");
    expect(new TextDecoder().decode(content.images[0]?.source.bytes)).toBe("hi");
  });

  it("omits malformed image inputs without failing text conversion", () => {
    expect(
      extractKiroContent([{ type: "text", text: "safe" }, { type: "image_url" }]),
    ).toEqual({ text: "safe", images: [] });
  });
});
