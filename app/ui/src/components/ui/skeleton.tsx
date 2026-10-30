import { cn } from "cn";

/**
 * A placeholder in the shape of content that is still loading: a muted block with a soft light
 * sweeping across it (still, for people who prefer reduced motion). All skeletons share one sweep
 * across the window (see `shimmer` in index.css).
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "rounded-md bg-muted bg-[linear-gradient(90deg,transparent_35%,color-mix(in_oklab,var(--foreground)_8%,transparent)_50%,transparent_65%)] bg-size-[300%_100%] bg-fixed bg-no-repeat motion-safe:animate-shimmer",
        className,
      )}
      {...props}
    />
  );
}
