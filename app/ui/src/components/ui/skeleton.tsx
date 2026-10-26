import { cn } from "cn";

/**
 * A placeholder in the shape of content that is still loading: a muted block with a soft light
 * sweeping across it (still, for people who prefer reduced motion).
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "rounded-md bg-muted bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--foreground)_7%,transparent),transparent)] bg-size-[200%_100%] bg-no-repeat motion-safe:animate-shimmer",
        className,
      )}
      {...props}
    />
  );
}
