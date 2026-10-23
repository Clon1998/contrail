import { cn } from "cn";
import type { SessionStatus } from "@/bindings";
import { useNow } from "@/hooks/useNow";
import { describeSession, type SessionView } from "@/lib/session";

const DOT: Record<SessionView["tone"], string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

/** A coloured dot for a session state (used in the switcher trigger). */
export function SessionDot({
  status,
  rejected,
  className,
}: {
  status?: SessionStatus;
  rejected?: boolean;
  className?: string;
}) {
  const now = useNow();
  const { tone, label } = describeSession(status, now, rejected);
  return (
    <span
      aria-label={label}
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT[tone], className)}
    />
  );
}

/** Dot plus label, e.g. "valid · 6h 59m" or "expired 2h 00m ago". */
export function SessionBadge({ status, rejected }: { status?: SessionStatus; rejected?: boolean }) {
  const now = useNow();
  const { tone, label } = describeSession(status, now, rejected);
  return (
    <span
      data-tone={tone}
      className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground"
    >
      <span className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />
      {label}
    </span>
  );
}
