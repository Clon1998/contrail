import { CircleAlertIcon, Loader2Icon } from "lucide-react";
import { isRejected } from "@/lib/session";
import { useProfiles } from "@/stores/profiles";

/** "connected as ReadOnly/someone · 111122223333", or what went wrong. */
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
      // `arn:aws:sts::123:assumed-role/Role/user` → `Role/user`
      const who = identity.identity.arn
        .split(":")
        .at(-1)
        ?.replace(/^assumed-role\//, "");
      return (
        <span className="truncate text-xs text-muted-foreground" title={identity.identity.arn}>
          connected as <span className="text-foreground">{who}</span> ·{" "}
          <span className="font-mono">{identity.identity.account}</span>
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
