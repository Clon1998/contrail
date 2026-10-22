import { describe, expect, it } from "vitest";
import { formatLogTime, stripAnsi } from "./logs";

describe("log helpers", () => {
  it("formats times with milliseconds in UTC", () => {
    expect(formatLogTime("2026-01-15T09:12:01.768108328Z", "utc")).toBe("09:12:01.768");
  });

  it("strips ANSI colour codes", () => {
    expect(stripAnsi("\u001b[32m INFO\u001b[0;39m ok")).toBe(" INFO ok");
  });
});

describe("stack traces and JSON", () => {
  it("classifies stack trace lines", async () => {
    const { classifyTrace } = await import("./logs");
    const kinds = classifyTrace(
      "java.lang.X: boom\n\tat a.B.c(B.java:1)\nCaused by: java.io.IOException\n\t... 12 common frames omitted\n",
    ).map((l) => l.kind);
    expect(kinds).toEqual(["header", "frame", "causedBy", "omitted"]);
  });

  it("pretty-prints and tokenizes JSON", async () => {
    const { prettyJson, tokenizeJson } = await import("./logs");
    expect(prettyJson("not json")).toBeNull();
    const pretty = prettyJson('{"a":1,"b":"x","c":true}') ?? "";
    const kinds = tokenizeJson(pretty)
      .filter((t) => t.kind !== "punctuation")
      .map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toEqual([
      'key:"a"',
      "number:1",
      'key:"b"',
      'string:"x"',
      'key:"c"',
      "literal:true",
    ]);
  });

  it("splits a message around embedded JSON using byte offsets", async () => {
    const { splitEmbeddedJson } = await import("./logs");
    // "ü" is 2 bytes in UTF-8, so the span from Rust is shifted against JavaScript's indices.
    const message = 'Fehler ü: {"a":1} end';
    expect(splitEmbeddedJson(message, [11, 18])).toEqual({
      before: "Fehler ü: ",
      json: '{"a":1}',
      after: " end",
    });
  });
});
