import { describe, expect, it } from "vitest";
import {
  lowPriorityRunOptions,
  priorityResultStatus,
} from "../src/priority.js";
import type { ReservationResult, RunMode } from "../src/types.js";

function result(
  status: ReservationResult["status"],
  mode: RunMode = "submit",
): ReservationResult {
  return {
    mode,
    planId: "plan",
    targetDate: "2026-09-23",
    status,
    message: status,
    launchRequests: status === "confirmed" ? 1 : 0,
  };
}

describe("priority pair status", () => {
  it("confirms only when both submitted reservations are confirmed", () => {
    expect(priorityResultStatus(result("confirmed"), result("confirmed"), "submit"))
      .toBe("confirmed");
  });

  it("keeps a single successful child as partial", () => {
    expect(priorityResultStatus(result("confirmed"), result("failed"), "submit"))
      .toBe("partial");
    expect(priorityResultStatus(result("failed"), result("confirmed"), "submit"))
      .toBe("partial");
  });

  it("surfaces an ambiguous child instead of retrying it", () => {
    expect(priorityResultStatus(result("confirmed"), result("ambiguous"), "submit"))
      .toBe("ambiguous");
  });

  it("treats an unverified submitted child as ambiguous", () => {
    expect(priorityResultStatus(result("submitted"), result("failed"), "submit"))
      .toBe("ambiguous");
  });

  it("marks two dry-runs ready", () => {
    expect(priorityResultStatus(
      result("ready", "dry-run"),
      result("ready", "dry-run"),
      "dry-run",
    )).toBe("ready");
  });
});

describe("low-priority release barrier", () => {
  const notBefore = new Date("2026-10-20T07:00:00+08:00");

  it("inherits the release barrier when high priority ends early", () => {
    expect(lowPriorityRunOptions(
      { notBefore, maxLatenessMs: 120_000 },
      new Date("2026-10-20T06:57:14+08:00").getTime(),
    )).toEqual({ notBefore, maxLatenessMs: 120_000 });
  });

  it("runs immediately after the release time", () => {
    expect(lowPriorityRunOptions(
      { notBefore, maxLatenessMs: 120_000 },
      new Date("2026-10-20T07:00:04+08:00").getTime(),
    )).toEqual({});
  });
});
