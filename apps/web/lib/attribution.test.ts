import { describe, expect, it } from "vitest";
import { datafastAttribution, readCookie } from "./attribution";

describe("datafast attribution", () => {
  it("reads both ids from the cookie header", () => {
    expect(
      datafastAttribution("a=1; datafast_visitor_id=v_123; datafast_session_id=s-456; b=2"),
    ).toEqual({ datafastVisitorId: "v_123", datafastSessionId: "s-456" });
  });
  it("returns undefined without DataFast cookies", () => {
    expect(datafastAttribution("a=1; b=2")).toBeUndefined();
    expect(datafastAttribution("")).toBeUndefined();
  });
  it("drops malformed values", () => {
    expect(datafastAttribution("datafast_visitor_id=<script>; datafast_session_id=ok")).toEqual({
      datafastSessionId: "ok",
    });
    expect(readCookie("x=%E0%A4%A", "x")).toBeUndefined();
  });
});
