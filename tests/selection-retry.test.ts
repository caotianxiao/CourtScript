import { describe, expect, it } from "vitest";
import { decideSelectionAction } from "../src/reservation.js";

describe("slot selection retry", () => {
  it("accepts a complete resource summary without clicking again", () => {
    expect(decideSelectionAction({
      summary: true,
      phone: true,
      active: true,
    })).toBe("confirmed");
  });

  it("waits rather than toggling an active cell off", () => {
    expect(decideSelectionAction({
      summary: false,
      phone: true,
      active: true,
    })).toBe("wait");
  });

  it("waits for a phone number when the resource summary already exists", () => {
    expect(decideSelectionAction({
      summary: true,
      phone: false,
      active: false,
    })).toBe("wait");
  });

  it("clicks only when neither the cell nor summary is selected", () => {
    expect(decideSelectionAction({
      summary: false,
      phone: true,
      active: false,
    })).toBe("click");
  });
});
