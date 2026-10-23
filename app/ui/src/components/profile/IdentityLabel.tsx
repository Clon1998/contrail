import { CircleAlertIcon, Loader2Icon, UserIcon } from "lucide-react";
import { isRejected, roleName } from "@/lib/session";
import { useProfiles } from "@/stores/profiles";

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
        <span
          className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
          title={`Connected as ${arn}\nAccount ${account}`}
        >
          <UserIcon className="size-3 shrink-0" />
          <span className="truncate text-foreground">{roleName(arn)}</span>
        </span>
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
