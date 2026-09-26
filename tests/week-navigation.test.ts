import { describe, expect, it } from "vitest";
import {
  decideReleaseLoadStrategy,
  decideWeekNavigation,
} from "../src/week-navigation.js";

describe("week navigation", () => {
  it("trusts a rendered target column even while range inputs are empty", () => {
    expect(decideWeekNavigation("2026-09-24", {
      start: "",
      end: "",
      visibleDates: ["2026-09-24"],
    })).toBe("visible");
  });

  it("waits for date inputs instead of treating empty values as an older week", () => {
    expect(decideWeekNavigation("2026-09-24", {
      start: "",
      end: "",
      visibleDates: [],
    })).toBe("wait");
  });

  it("waits when the range contains the target but its column is still loading", () => {
    expect(decideWeekNavigation("2026-09-24", {
      start: "2026-09-21",
      end: "2026-09-27",
      visibleDates: ["2026-09-21", "2026-09-22"],
    })).toBe("wait");
  });

  it("navigates only after a complete range proves the target is outside it", () => {
    expect(decideWeekNavigation("2026-09-20", {
      start: "2026-09-21",
      end: "2026-09-27",
      visibleDates: [],
    })).toBe("前一周");
    expect(decideWeekNavigation("2026-09-28", {
      start: "2026-09-21",
      end: "2026-09-27",
      visibleDates: [],
    })).toBe("后一周");
  });

  it("loads a later week by navigating once at release", () => {
    expect(decideReleaseLoadStrategy("后一周")).toBe("navigate-at-release");
    expect(decideReleaseLoadStrategy("visible")).toBe("reload");
    expect(decideReleaseLoadStrategy("前一周")).toBe("reload");
  });
});
