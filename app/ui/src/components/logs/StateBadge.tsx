import { cn } from "cn";
import { stateTone } from "./states";

/** A pipeline state as a small outlined label (in rows, chips and details). */
export function StateBadge({ state, className }: { state: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1 font-sans text-[10px] leading-4 font-medium tracking-wide",
        stateTone(state),
        className,
      )}
    >
      {state}
    </span>
  );
}
