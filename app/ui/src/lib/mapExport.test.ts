import { describe, expect, it } from "vitest";
import { dataUrlToBase64, mapFileName } from "./mapExport";

describe("map export", () => {
  it("passes a PNG's base64 through", () => {
    expect(dataUrlToBase64("data:image/png;base64,iVBORw0KGgo=")).toBe("iVBORw0KGgo=");
  });

  it("encodes an SVG's text as UTF-8 base64", () => {
    const svg = "<svg><text>Größe → ok</text></svg>";
    const encoded = dataUrlToBase64(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(svg);
  });

  it("names the file after the cluster and the time", () => {
    expect(mapFileName("demo-edge", new Date(2026, 9, 26, 9, 5))).toBe(
      "routes-demo-edge-20261026-0905",
    );
  });
});
