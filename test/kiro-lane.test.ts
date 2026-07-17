import { describe, expect, it } from "vitest";

import {
  resetKiroAccountLanes,
  withKiroAccountLane,
} from "../lib/providers/kiro/request/account-lane.js";

describe("Kiro account lane", () => {
  it("serializes the same account and overlaps different accounts", async () => {
    resetKiroAccountLanes();
    const order: string[] = [];
    const same = Promise.all([
      withKiroAccountLane("a", async (release) => {
        order.push("a1-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("a1-end");
        release();
        return 1;
      }),
      withKiroAccountLane("a", async (release) => {
        order.push("a2-start");
        release();
        return 2;
      }),
    ]);
    const other = withKiroAccountLane("b", async (release) => {
      order.push("b-start");
      release();
      return 3;
    });
    await Promise.all([same, other]);
    expect(order.indexOf("a1-start")).toBeLessThan(order.indexOf("a1-end"));
    expect(order.indexOf("a1-end")).toBeLessThan(order.indexOf("a2-start"));
    expect(order).toContain("b-start");
  });

  it("releases exactly once even if release is called twice", async () => {
    resetKiroAccountLanes();
    let releases = 0;
    await withKiroAccountLane("c", async (release) => {
      const wrapped = () => {
        releases++;
        release();
      };
      wrapped();
      wrapped();
      return true;
    });
    expect(releases).toBe(2);
    await withKiroAccountLane("c", async (release) => {
      release();
      return true;
    });
  });
});
