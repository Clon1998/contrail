import { Link2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLinks } from "@/stores/links";
import { useProfiles } from "@/stores/profiles";

/**
 * Below the top bar while a shared link waits for its profile (a login, say), or when it can't be
 * opened, with why.
 */
export function LinkNotice() {
  const pending = useLinks((s) => s.pending);
  const problem = useLinks((s) => s.problem);
  const dismiss = useLinks((s) => s.dismiss);
  const connected = useProfiles((s) => s.identity.state === "ok");
  if (!problem && !pending) return null;

  return (
    <section
      aria-label="Shared link"
      className="flex items-start gap-2 border-b border-border bg-card/50 px-4 py-2 text-xs"
    >
      <Link2Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {problem ? (
          <p className="text-destructive">
            {problem.message}
            {problem.hint && <span className="block text-muted-foreground">{problem.hint}</span>}
          </p>
        ) : (
          pending && (
            <p>
              Opening a shared link to <span className="font-medium">{pending.serviceName}</span>
              {connected ? "…" : ` once you're logged in to ${pending.profile}.`}
            </p>
          )
        )}
      </div>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={dismiss}>
        <XIcon />
      </Button>
    </section>
  );
}
