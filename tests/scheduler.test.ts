import { describe, expect, it } from "vitest";
import { hardwareWakeAt, pmsetDate } from "../src/scheduler.js";

describe("priority hardware wake", () => {
  it("schedules a 06:55 Shanghai wake for a 07:00 release", () => {
    const release = new Date("2026-10-20T07:00:00+08:00");
    const wake = hardwareWakeAt(release, 5);
    expect(wake.toISOString()).toBe("2026-10-19T22:55:00.000Z");
    expect(pmsetDate(wake)).toBe("10/20/26 06:55:00");
  });

  it("rejects an unsafe wake offset", () => {
    expect(() => hardwareWakeAt(new Date(), 0)).toThrow("1–30");
  });
});
