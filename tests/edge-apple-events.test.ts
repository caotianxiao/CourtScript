import { describe, expect, it } from "vitest";
import { waitForCourtResult } from "../src/edge-apple-events.js";

describe("Apple Events read retry", () => {
  it("retries transient Apple Events timeouts without replaying an action", async () => {
    let calls = 0;
    const result = await waitForCourtResult<{ url: string }>(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("Apple Events 调用超时（8 秒）");
        }
        return JSON.stringify({ url: "https://ehall.fudan.edu.cn/" });
      },
      (value) => Boolean(value.url),
      0,
      "连接普通 Edge",
      { minimumAttempts: 3, retryDelayMs: 0 },
    );

    expect(calls).toBe(3);
    expect(result.url).toContain("ehall.fudan.edu.cn");
  });

  it("stops after the configured minimum attempts remain unsuccessful", async () => {
    let calls = 0;
    await expect(waitForCourtResult(
      async () => {
        calls += 1;
        throw new Error("Apple Events 调用超时（8 秒）");
      },
      () => false,
      0,
      "连接普通 Edge",
      { minimumAttempts: 3, retryDelayMs: 0 },
    )).rejects.toThrow("连接普通 Edge超时");
    expect(calls).toBe(3);
  });
});
