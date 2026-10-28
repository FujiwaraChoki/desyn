import { describe, expect, it } from "vitest";
import { attributionMetadata } from "../lib/billing_attribution";

describe("checkout attribution metadata", () => {
  it("maps DataFast ids to the metadata keys DataFast reads", () => {
    expect(attributionMetadata({ datafastVisitorId: "v_1", datafastSessionId: "s-2" })).toEqual({
      datafast_visitor_id: "v_1",
      datafast_session_id: "s-2",
    });
  });
  it("drops missing and malformed values", () => {
    expect(attributionMetadata(undefined)).toEqual({});
    expect(
      attributionMetadata({ datafastVisitorId: "a b", datafastSessionId: "x".repeat(129) }),
    ).toEqual({});
    expect(attributionMetadata({ datafastSessionId: "ok" })).toEqual({ datafast_session_id: "ok" });
  });
});
