import { cn } from "cn";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** A card with a title (and an optional action) for one part of the overview. */
export function OverviewCard({
  title,
  count,
  action,
  className,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card role="region" aria-label={title} className={cn("gap-3 py-3 shadow-none", className)}>
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          {title}
          {count !== undefined && (
            <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
          )}
        </CardTitle>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  );
}
