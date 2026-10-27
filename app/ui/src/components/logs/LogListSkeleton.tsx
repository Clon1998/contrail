import { Skeleton } from "@/components/ui/skeleton";

/** Message widths of the placeholder rows, so they don't look like one block. */
const WIDTHS = ["w-3/4", "w-1/2", "w-5/6", "w-2/3", "w-2/5", "w-3/5"];

/**
 * Log lines that are still loading: the timeline (when it's shown) and rows with a time, a level
 * and a message of varying length.
 */
export function LogListSkeleton({ timeline, label }: { timeline: boolean; label: string }) {
  return (
    <div role="status" aria-label={label} className="flex min-h-0 flex-col overflow-hidden">
      <span className="sr-only">{label}…</span>
      {timeline && (
        <div className="border-b border-border px-4 pt-1.5 pb-1">
          <Skeleton className="h-7" />
          <div className="h-[15px]" />
        </div>
      )}
      <div className="flex flex-col gap-2 px-4 py-2">
        {Array.from({ length: 14 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-3.5 w-[12ch] shrink-0" />
            <Skeleton className="h-3.5 w-[5ch] shrink-0" />
            <Skeleton className={`h-3.5 ${WIDTHS[i % WIDTHS.length]}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
