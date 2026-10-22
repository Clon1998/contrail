import { cn } from "cn";
import { serviceHealth, type ServiceHealth } from "@/lib/ecs";
import type { ServiceSummary } from "@/bindings";

const COLOR: Record<ServiceHealth, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  idle: "bg-muted-foreground/40",
};

const LABEL: Record<ServiceHealth, string> = {
  ok: "all tasks running",
  warn: "fewer tasks running than desired",
  bad: "no tasks running",
  idle: "scaled to zero",
};

/** A coloured dot for a service's task counts. */
export function HealthDot({
  service,
}: {
  service: Pick<ServiceSummary, "desired" | "running" | "pending">;
}) {
  const health = serviceHealth(service);
  return (
    <span
      role="img"
      aria-label={LABEL[health]}
      className={cn("inline-block size-2 shrink-0 rounded-full", COLOR[health])}
    />
  );
}
