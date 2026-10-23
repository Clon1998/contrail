import { describe, expect, it } from "vitest";
import { hiddenForAtLeast, hiddenForOnly, toggleLevel } from "./levels";

describe("level chips", () => {
  it("toggle one level", () => {
    expect(toggleLevel([], "INFO")).toEqual(["INFO"]);
    expect(toggleLevel(["INFO", "DEBUG"], "INFO")).toEqual(["DEBUG"]);
  });

  it("show only one level, or everything again when it already is the only one", () => {
    expect(hiddenForOnly([], "WARN")).toEqual(["ERROR", "INFO", "DEBUG", "TRACE"]);
    expect(hiddenForOnly(["ERROR", "INFO", "DEBUG", "TRACE"], "WARN")).toEqual([]);
  });

  it("show a level and everything more severe", () => {
    expect(hiddenForAtLeast("WARN")).toEqual(["INFO", "DEBUG", "TRACE"]);
    expect(hiddenForAtLeast("TRACE")).toEqual([]);
  });
});
