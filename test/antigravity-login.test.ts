import { describe, expect, it, vi } from "vitest";
import {
  addActionsForProvider,
  actionMenuItems,
  createActionMenuLevel,
  openActionMenuGroup,
} from "../lib/tui/action-helpers.js";
import { buildAuthorizeUrl } from "../lib/providers/antigravity/auth/oauth.js";
import { GOOGLE_CLIENT_ID } from "../lib/providers/antigravity/constants.js";

describe("antigravity tui add actions and oauth login", () => {
  it("provides correct add actions for antigravity provider", () => {
    const actions = addActionsForProvider("antigravity");
    expect(actions).toEqual(["add-browser", "add-antigravity-9router"]);
  });

  it("builds valid Google OAuth authorization URL for Antigravity", () => {
    const urlStr = buildAuthorizeUrl({
      state: "test-state-123",
      redirectUri: "http://localhost:8085/oauth/callback",
    });
    const url = new URL(urlStr);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8085/oauth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("test-state-123");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/cloud-platform");
  });

  it("lists browser and 9router import options in add group menu", () => {
    const level = openActionMenuGroup(createActionMenuLevel(), "add");
    const items = actionMenuItems(level, "antigravity");
    const actions = items
      .filter((i) => i.kind === "action")
      .map((i) => (i.kind === "action" ? i.binding.action : ""));
    expect(actions).toEqual(["add-browser", "add-antigravity-9router"]);
  });
});
