import { describe, expect, it } from "vitest";

import { isProviderAdapter } from "../lib/core/adapter.js";
import { kiroAdapter } from "../lib/providers/kiro/adapter.js";

describe("kiroAdapter", () => {
  it("is a custom-transport provider descriptor", () => {
    expect(isProviderAdapter(kiroAdapter)).toBe(true);
    expect(kiroAdapter.id).toBe("kiro-multi");
    expect(kiroAdapter.provider).toBe("kiro");
    expect(kiroAdapter.transport.kind).toBe("custom");
    expect(kiroAdapter.providerDefaultOptions()).toEqual({
      accountSelectionStrategy: "sticky",
    });
  });
});
