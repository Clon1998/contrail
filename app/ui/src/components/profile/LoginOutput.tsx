import { useState } from "react";
import { CopyIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProfiles } from "@/stores/profiles";

/**
 * A running login, below the top bar while it runs and after a failure: what `aws sso login`
 * printed (the CLI opens the browser itself; the output holds the URL and code for when it
 * doesn't), or the code of the built-in login, whose page Contrail opened in the browser.
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
          {login.device && <DeviceCode {...login.device} running={login.running} />}
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

/** The code to confirm, and the page for when the browser didn't open. */
function DeviceCode({ url, code, running }: { url: string; code: string; running: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div aria-label="Login code" className="space-y-1">
      {running && (
        <p className="text-muted-foreground">
          Check that the browser shows this code, then confirm:
        </p>
      )}
      <p className="font-mono text-base font-semibold tracking-widest select-text">{code}</p>
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <span className="truncate select-text" title={url}>
          {url}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Copy the login page address"
          tooltip={copied ? "Copied" : "Copy (if the browser didn't open)"}
          onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}
        >
          <CopyIcon />
        </Button>
      </p>
    </div>
  );
}
