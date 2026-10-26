import { describe, expect, it } from "vitest";
import { consoleFilter, regionOf } from "./links";

describe("links", () => {
  it("reads the region of a cluster", () => {
    expect(regionOf("arn:aws:ecs:eu-central-1:111122223333:cluster/core")).toBe("eu-central-1");
  });

  it("passes only plain text on to the console", () => {
    expect(consoleFilter(" read timed out ", false)).toBe("read timed out");
    expect(consoleFilter("order-42", false)).toBe("order-42");
    expect(consoleFilter("level:ERROR", false)).toBeNull();
    expect(consoleFilter("timeout -health", false)).toBeNull();
    expect(consoleFilter("order \\d+", true)).toBeNull();
    expect(consoleFilter("", false)).toBeNull();
  });
});
