import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProfiles } from "@/stores/profiles";

/**
 * What `aws sso login` printed, below the top bar while it runs and after a failure. The CLI
 * opens the browser itself; the output holds the URL and code for when it doesn't.
 */
export function LoginOutput() {
  const login = useProfiles((s) => s.login);
  const dismiss = useProfiles((s) => s.dismissLogin);

  // A successful login needs no panel: the status badge turns green.
  if (!login || (!login.running && !login.error)) return null;

  return (
    <section
      aria-label="Login output"
      className="border-b border-border bg-card/50 px-4 py-2 text-xs"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">
            {login.running
              ? `Logging in to ${login.profile} — approve the request in your browser.`
              : `Login to ${login.profile} failed.`}
          </p>
          {login.lines.length > 0 && (
            <pre className="max-h-32 overflow-auto font-mono whitespace-pre-wrap text-muted-foreground select-text">
              {login.lines.join("\n")}
            </pre>
          )}
          {login.error && (
            <p className="text-destructive">
              {login.error.message}
              {login.error.hint && (
                <span className="block text-muted-foreground">{login.error.hint}</span>
              )}
            </p>
          )}
        </div>
        {!login.running && (
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={dismiss}>
            <XIcon />
          </Button>
        )}
      </div>
    </section>
  );
}
