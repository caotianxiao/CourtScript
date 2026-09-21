import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  normalizeSlots,
  releaseDateFor,
  shanghaiDate,
  validateDate,
  validateSlot,
} from "../src/validation.js";

describe("validation", () => {
  it("validates real calendar dates", () => {
    expect(validateDate("2026-09-21")).toBe("2026-09-21");
    expect(() => validateDate("2026-02-29")).toThrow("日期不存在");
    expect(() => validateDate("21-09-2026")).toThrow("YYYY-MM-DD");
  });

  it("validates slots", () => {
    expect(validateSlot("08:00-09:00")).toBe("08:00-09:00");
    expect(() => validateSlot("09:00-08:00")).toThrow("不合法");
    expect(() => validateSlot("8:00-9:00")).toThrow("HH:mm-HH:mm");
  });

  it("preserves priority and removes duplicate fallbacks", () => {
    expect(
      normalizeSlots("08:00-09:00", ["09:00-10:00", "08:00-09:00"]),
    ).toEqual(["08:00-09:00", "09:00-10:00"]);
  });

  it("computes the two-day release date", () => {
    expect(releaseDateFor("2026-09-21")).toBe("2026-09-19");
    expect(addCalendarDays("2027-01-01", -2)).toBe("2026-12-30");
  });

  it("uses the Shanghai calendar date", () => {
    expect(shanghaiDate(new Date("2026-09-20T16:30:00Z"))).toBe("2026-09-21");
  });
});
