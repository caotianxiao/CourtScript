import { describe, expect, it } from "vitest";
import { priorityResultStatus } from "../src/priority.js";
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

  it("marks two dry-runs ready", () => {
    expect(priorityResultStatus(
      result("ready", "dry-run"),
      result("ready", "dry-run"),
      "dry-run",
    )).toBe("ready");
  });
});
