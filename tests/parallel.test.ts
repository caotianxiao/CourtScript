import { describe, expect, it } from "vitest";
import {
  buildParallelLanePlan,
  parallelSubmitStatus,
} from "../src/parallel-feasibility.js";

describe("parallel lane isolation", () => {
  it("keeps A enabled when B is unavailable", () => {
    const plan = buildParallelLanePlan([true, false], 150);
    expect(plan.map((lane) => ({
      label: lane.label,
      available: lane.available,
      delay: lane.submitDelayMs,
    }))).toEqual([
      { label: "A", available: true, delay: 0 },
      { label: "B", available: false, delay: 150 },
    ]);
  });

  it("keeps B enabled with its stagger when A is unavailable", () => {
    const plan = buildParallelLanePlan([false, true], 150);
    expect(plan[0].available).toBe(false);
    expect(plan[1]).toMatchObject({ available: true, submitDelayMs: 150 });
  });

  it("confirms two independently verified submissions", () => {
    expect(parallelSubmitStatus([true, true], [true, true])).toBe("confirmed");
  });

  it("reports one verified submission as partial success", () => {
    expect(parallelSubmitStatus([true, false], [true, false])).toBe("partial");
    expect(parallelSubmitStatus([false, true], [false, true])).toBe("partial");
  });

  it("fails cleanly when neither lane can submit", () => {
    expect(parallelSubmitStatus([false, false])).toBe("failed");
  });

  it("keeps an unverified submitted lane ambiguous", () => {
    expect(parallelSubmitStatus([true, false], [false, false])).toBe("ambiguous");
    expect(parallelSubmitStatus([true, true], [true, false])).toBe("ambiguous");
  });
});
