import { useEffect } from "react";
import { Loader2Icon, LogInIcon } from "lucide-react";
import type { ApiError } from "@/bindings";
import { Button } from "@/components/ui/button";
import { canLogin, sessionExpired } from "@/lib/session";
import { useProfiles } from "@/stores/profiles";

/**
 * "Log in" right where a call failed because the SSO session ran out, so nobody has to find the
 * button in the top bar (which shows it too from now on). After a successful login, `onLoggedIn`
 * repeats what failed.
 */
export function LoginAgain({
  error,
  onLoggedIn,
}: {
  error: ApiError | null | undefined;
  onLoggedIn?: () => void;
}) {
  const expired = sessionExpired(error);
  const profile = useProfiles((s) => s.profiles.find((p) => p.name === s.selected));
  const running = useProfiles((s) => s.login?.running ?? false);
  const startLogin = useProfiles((s) => s.startLogin);
  const sessionRejected = useProfiles((s) => s.sessionRejected);

  useEffect(() => {
    if (error && sessionExpired(error)) sessionRejected(error);
  }, [error, sessionRejected]);

  if (!expired || !canLogin(profile)) return null;
  return (
    <Button
      size="xs"
      disabled={running}
      onClick={async () => {
        await startLogin();
        if (useProfiles.getState().identity.state === "ok") onLoggedIn?.();
      }}
    >
      {running ? <Loader2Icon className="animate-spin" /> : <LogInIcon />}
      {running ? "Waiting for browser…" : "Log in"}
    </Button>
  );
}
