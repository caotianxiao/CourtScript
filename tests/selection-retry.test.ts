import { describe, expect, it } from "vitest";
import {
  decideSelectionAction,
  isSelectedSlotCell,
} from "../src/reservation.js";

describe("slot selection retry", () => {
  it("does not confuse a sold-out active cell with a selected cell", () => {
    expect(isSelectedSlotCell(
      "约满 (15/15)",
      "red active no_active resource_item_info",
    )).toBe(false);
  });

  it("recognizes only an active reservable cell as selected", () => {
    expect(isSelectedSlotCell(
      "可预约 (1/15)",
      "green active pointer can_active resource_item_info",
    )).toBe(true);
    expect(isSelectedSlotCell(
      "可预约 (1/15)",
      "green pointer can_active resource_item_info",
    )).toBe(false);
  });

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
