import { describe, expect, it } from "vitest";
import {
  interpretSubmissionResponse,
  launchMonitorJavaScript,
} from "../src/reservation.js";

describe("submission request monitor", () => {
  it("generates valid browser JavaScript and matches either launch path prefix", () => {
    const source = launchMonitorJavaScript();
    expect(() => new Function(source)).not.toThrow();
    expect(source).toContain("/site/resource/launch");
    expect(source).toContain("endsWith(launchSuffix)");
  });
});

describe("submission response interpretation", () => {
  it("recognizes an explicit successful booking response", () => {
    expect(interpretSubmissionResponse(
      200,
      JSON.stringify({ success: true, message: "预约成功" }),
    )).toMatchObject({
      outcome: "success",
      responseMessage: "预约成功",
    });
    expect(interpretSubmissionResponse(
      200,
      JSON.stringify({ success: true, error: null }),
    )).toMatchObject({ outcome: "success" });
  });

  it("recognizes a completed business rejection", () => {
    expect(interpretSubmissionResponse(
      200,
      JSON.stringify({ success: false, message: "场地已约满" }),
    )).toMatchObject({
      outcome: "failure",
      responseMessage: "场地已约满",
    });
  });

  it("recognizes an HTTP or transport failure", () => {
    expect(interpretSubmissionResponse(503, "")).toMatchObject({
      outcome: "failure",
    });
    expect(interpretSubmissionResponse(0, "", "network error")).toMatchObject({
      outcome: "failure",
    });
  });

  it("keeps a completed but undocumented response conservative", () => {
    expect(interpretSubmissionResponse(200, JSON.stringify({ code: 20000 })))
      .toMatchObject({ outcome: "unknown", applicationCode: "20000" });
  });
});
