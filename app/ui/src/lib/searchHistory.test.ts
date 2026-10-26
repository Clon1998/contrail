import { describe, expect, it } from "vitest";
import type { SearchEntry } from "@/bindings";
import { recallList } from "./searchHistory";

const entry = (query: string, regex = false): SearchEntry => ({ query, regex, raw: false });

describe("recallList", () => {
  it("lists the service's searches first, then the others once", () => {
    const history = {
      perService: { orders: [entry("timeout"), entry("state:FAILED")] },
      global: [
        entry("level:ERROR"),
        entry("timeout"),
        entry("timeout", true),
        entry("state:FAILED"),
      ],
    };
    expect(
      recallList(history, "orders").map((e) => `${e.query}${e.regex ? " (regex)" : ""}`),
    ).toEqual(["timeout", "state:FAILED", "level:ERROR", "timeout (regex)"]);
    expect(recallList(history, "payments")).toHaveLength(4);
  });
});
