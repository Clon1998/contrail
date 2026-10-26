import { describe, expect, it } from "vitest";
import type { Field, LogEvent } from "@/bindings";
import { abbreviateLogger, columnText, columnValue } from "./columns";

function event(fields: Field[]): LogEvent {
  const timestamp = "2026-10-23T08:00:00Z";
  return {
    seq: 1,
    timestamp,
    cwTimestamp: timestamp,
    stream: "ecs/app/abc",
    taskId: "abc",
    raw: "{}",
    status: null,
    line: {
      kind: "ecs",
      timestamp,
      level: "INFO",
      message: "m",
      fields,
      error: null,
      jsonSpan: null,
    },
  };
}

describe("correlation column", () => {
  it("finds a correlation ID under any prefix", () => {
    const e = event([
      { key: "acme.state", value: "RECEIVED" },
      { key: "acme.correlationId", value: "DE40C0DE00000001-0000000000001EEF" },
    ]);
    expect(columnValue(e, "correlation")).toBe("DE40C0DE00000001-0000000000001EEF");
  });

  it("prefers a correlation ID over a trace ID", () => {
    const e = event([
      { key: "trace.id", value: "t-1" },
      { key: "x.correlation_id", value: "c-1" },
    ]);
    expect(columnValue(e, "correlation")).toBe("c-1");
    expect(columnValue(event([{ key: "trace.id", value: "t-1" }]), "correlation")).toBe("t-1");
  });

  it("falls back to a trace ID under any name (APIs log traceId, not a correlation ID)", () => {
    expect(columnValue(event([{ key: "traceId", value: "FsEwYFk0" }]), "correlation")).toBe(
      "FsEwYFk0",
    );
    expect(columnValue(event([{ key: "http.trace_id", value: "t-2" }]), "correlation")).toBe("t-2");
  });
});

describe("logger column", () => {
  it("keeps names that fit", () => {
    expect(abbreviateLogger("com.example.App", 22)).toBe("com.example.App");
  });

  it("shortens packages from the left until the name fits", () => {
    expect(abbreviateLogger("com.example.orders.OrderService", 23)).toBe("c.e.orders.OrderService");
    expect(abbreviateLogger("com.example.orders.OrderService", 20)).toBe("c.e.o.OrderService");
  });

  it("cuts the front when the class name alone is too long", () => {
    const short = abbreviateLogger("com.example.VeryLongOrderServiceImplementation", 12);
    expect(short).toBe("…lementation");
    expect(short).toHaveLength(12);
  });

  it("shows the logger shortened but keeps the full value", () => {
    const e = event([{ key: "log.logger", value: "com.example.pipeline.KafkaConsumer" }]);
    expect(columnText(e, "logger")).toBe("c.e.p.KafkaConsumer");
    expect(columnValue(e, "logger")).toBe("com.example.pipeline.KafkaConsumer");
  });
});
