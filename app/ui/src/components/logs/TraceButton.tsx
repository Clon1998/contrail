import { RouteIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLogs } from "@/stores/logs";
import { useTabs } from "@/stores/tabs";

/**
 * Follows one ID (a document's correlation ID, an API's trace ID) across the services of the
 * cluster, in a tab of its own (see TraceView).
 *
 * `term` is the search that lists the ID in one service (`correlation:<id>` or the quoted ID).
 */
export function TraceButton({ id, term, at }: { id: string; term: string; at: string }) {
  const service = useLogs((s) => s.service);
  if (!service) return null;
  return (
    <Button
      variant="outline"
      size="xs"
      tooltip="Find this ID in other services of the cluster and show the way it took (opens a tab)"
      onClick={() =>
        useTabs.getState().openTrace({
          id,
          term,
          at,
          clusterArn: service.clusterArn,
          origin: service.serviceName,
        })
      }
    >
      <RouteIcon /> Trace across services
    </Button>
  );
}
