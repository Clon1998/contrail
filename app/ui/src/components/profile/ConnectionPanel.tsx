import { CircleAlertIcon, PlugZapIcon } from "lucide-react";
import { canLogin, isRejected, needsLogin } from "@/lib/session";
import { LoginButton } from "./LoginButton";
import { useProfiles } from "@/stores/profiles";

/** The main area until ECS browsing exists: what to do next for the selected profile. */
export function ConnectionPanel() {
  const loading = useProfiles((s) => s.loading);
  const loadError = useProfiles((s) => s.loadError);
  const profiles = useProfiles((s) => s.profiles);
  const profile = useProfiles((s) => s.profiles.find((p) => p.name === s.selected));
  const status = useProfiles((s) => (s.selected ? s.statuses[s.selected] : undefined));
  const identity = useProfiles((s) => s.identity);

  let title: string;
  let detail: string | null = null;
  let problem = false;
  let login = false;

  if (loadError) {
    [title, detail, problem] = [loadError.message, loadError.hint, true];
  } else if (loading && profiles.length === 0) {
    title = "Loading profiles…";
  } else if (profiles.length === 0) {
    title = "No AWS profiles found";
    detail =
      "Contrail reads ~/.aws/config (or AWS_CONFIG_FILE). Set up SSO with `aws configure sso`.";
  } else if (!profile) {
    title = "Select a profile";
  } else if (profile.auth.kind === "misconfigured") {
    [title, detail, problem] = [
      `Profile ${profile.name} is misconfigured`,
      profile.auth.problem,
      true,
    ];
  } else if (needsLogin(status)) {
    title = `Log in to ${profile.name}`;
    detail = "The SSO session has expired. “Log in” runs aws sso login and opens your browser.";
    login = true;
  } else if (identity.state === "error" && isRejected(identity)) {
    title = `Log in to ${profile.name}`;
    detail = `AWS rejected the SSO session (${identity.error.message}). “Log in” runs aws sso login and opens your browser.`;
    login = true;
  } else if (identity.state === "error") {
    [title, detail, problem] = [identity.error.message, identity.error.hint, true];
  } else if (identity.state === "ok") {
    title = `Connected to ${profile.name}`;
    detail = `Account ${identity.identity.account}. Pick a service in the sidebar, or press ⌘K / Ctrl+K.`;
  } else {
    title = "Checking credentials…";
  }

  const Icon = problem ? CircleAlertIcon : PlugZapIcon;
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <Icon className={problem ? "size-6 text-destructive" : "size-6 text-muted-foreground"} />
      <h1 className="text-base font-medium">{title}</h1>
      {detail && <p className="max-w-md text-sm text-muted-foreground">{detail}</p>}
      {login && canLogin(profile) && <LoginButton />}
    </main>
  );
}
