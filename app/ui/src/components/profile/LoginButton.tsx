import { Loader2Icon, LogInIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canLogin, needsLogin } from "@/lib/session";
import { useProfiles } from "@/stores/profiles";

/** "Log in" for SSO profiles whose session is gone, expiring, or rejected by AWS. */
export function LoginButton() {
  const profile = useProfiles((s) => s.profiles.find((p) => p.name === s.selected));
  const status = useProfiles((s) => (s.selected ? s.statuses[s.selected] : undefined));
  const identity = useProfiles((s) => s.identity);
  const running = useProfiles((s) => s.login?.running ?? false);
  const startLogin = useProfiles((s) => s.startLogin);

  const rejected = identity.state === "error" && identity.error.code === "credentials";
  const show =
    canLogin(profile) && (needsLogin(status) || status?.state === "expiringSoon" || rejected);
  if (!show && !running) return null;

  return (
    <Button size="sm" onClick={() => void startLogin()} disabled={running}>
      {running ? <Loader2Icon className="animate-spin" /> : <LogInIcon />}
      {running ? "Waiting for browser…" : "Log in"}
    </Button>
  );
}
