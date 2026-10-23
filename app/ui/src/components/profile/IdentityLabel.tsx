import { CircleAlertIcon, Loader2Icon, UserIcon } from "lucide-react";
import { isRejected, roleName } from "@/lib/session";
import { useProfiles } from "@/stores/profiles";
import { Hint } from "@/components/ui/tooltip";

/** The role the credentials belong to (full ARN and account on hover), or what went wrong. */
export function IdentityLabel() {
  const identity = useProfiles((s) => s.identity);

  switch (identity.state) {
    case "idle":
      return null;
    case "checking":
      return (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" />
          checking credentials…
        </span>
      );
    case "ok": {
      const { arn, account } = identity.identity;
      return (
        <Hint content={`Connected as ${arn}\nAccount ${account}`}>
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <UserIcon className="size-3 shrink-0" />
            <span className="truncate text-foreground">{roleName(arn)}</span>
          </span>
        </Hint>
      );
    }
    case "error":
      // A rejected session is shown by the session dot, the Log in button and the main panel.
      if (isRejected(identity)) return null;
      return (
        <span
          className="flex min-w-0 items-center gap-1.5 text-xs text-destructive"
          title={identity.error.hint ?? undefined}
        >
          <CircleAlertIcon className="size-3 shrink-0" />
          <span className="truncate">{identity.error.message}</span>
        </span>
      );
  }
}
