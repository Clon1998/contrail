import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  AppInfo,
  AwsCtx,
  CallerIdentity,
  LoginProgress,
  Profile,
  SessionStatus,
} from "@/bindings";

/**
 * An in-memory stand-in for the Rust backend, mirroring demo mode (`contrail-fake`).
 *
 * Used by component tests and by the Playwright UI flows (`VITE_E2E=1`, see main.tsx), so the
 * UI can be exercised in a plain browser without Tauri or AWS.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;

function sso(accountId: string, roleName: string): Profile["auth"] {
  return {
    kind: "sso",
    accountId,
    roleName,
    startUrl: "https://demo-corp.awsapps.com/start",
    ssoRegion: "eu-central-1",
    sessionName: "demo-corp",
  };
}

export const DEMO_PROFILES: Profile[] = [
  { name: "demo-dev", region: "eu-central-1", auth: sso("111122223333", "ReadOnly") },
  { name: "demo-staging", region: "eu-central-1", auth: sso("222233334444", "ReadOnly") },
  { name: "demo-prod", region: "eu-west-1", auth: sso("333344445555", "ReadOnly") },
  { name: "demo-sandbox", region: "us-east-1", auth: sso("444455556666", "Admin") },
  { name: "demo-keys", region: "eu-central-1", auth: { kind: "staticKeys" } },
  {
    name: "demo-broken",
    region: "eu-central-1",
    auth: {
      kind: "misconfigured",
      problem: 'sso_session "gone" has no [sso-session gone] section',
    },
  },
];

export interface FakeBackendOptions {
  /** How long the fake login takes. */
  loginDelayMs?: number;
  /** Make every login fail with the CLI-missing error. */
  cliMissing?: boolean;
}

/** Creates the IPC handler. Each call starts from the initial demo state. */
export function createFakeBackend(options: FakeBackendOptions = {}) {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  // Session expiry per profile; `null` = logged out. Profiles without an entry aren't SSO.
  const expiry: Record<string, number | null> = {
    "demo-dev": now + 7 * HOUR,
    "demo-staging": now + 9 * MINUTE,
    "demo-prod": now - 2 * HOUR,
    "demo-sandbox": null,
  };

  function status(name: string): SessionStatus {
    if (!(name in expiry)) return { state: "notSso" };
    const expiresAt = expiry[name];
    if (expiresAt === null || expiresAt === undefined) return { state: "loggedOut" };
    if (expiresAt <= Date.now()) return { state: "expired", expiredAt: iso(expiresAt) };
    if (expiresAt - Date.now() < 15 * MINUTE)
      return { state: "expiringSoon", expiresAt: iso(expiresAt) };
    return { state: "valid", expiresAt: iso(expiresAt) };
  }

  function sendProgress(channel: { id: number }, index: number, message: LoginProgress) {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void };
      }
    ).__TAURI_INTERNALS__;
    internals.runCallback(channel.id, { index, message });
  }

  return async (cmd: string, payload?: InvokeArgs): Promise<unknown> => {
    const args = payload as Record<string, unknown> | undefined;
    switch (cmd) {
      case "app_info":
        return { version: "0.1.0", demo: true } satisfies AppInfo;
      case "list_profiles":
        return DEMO_PROFILES;
      case "session_status":
        return status(args?.profile as string);
      case "caller_identity": {
        const ctx = args?.ctx as AwsCtx;
        const profile = DEMO_PROFILES.find((p) => p.name === ctx.profile);
        const state = status(ctx.profile).state;
        if (state === "expired" || state === "loggedOut") {
          throw {
            code: "credentials",
            message: `no valid credentials for profile "${ctx.profile}"`,
            hint: `Log in again (aws sso login --profile ${ctx.profile}).`,
          };
        }
        const account = profile?.auth.kind === "sso" ? profile.auth.accountId : "999988887777";
        return {
          account,
          arn: `arn:aws:sts::${account}:assumed-role/DemoReadOnly/demo.user`,
          userId: "AROADEMOEXAMPLE:demo.user",
        } satisfies CallerIdentity;
      }
      case "sso_login": {
        const name = args?.profile as string;
        const channel = args?.onProgress as { id: number };
        if (options.cliMissing) {
          throw {
            code: "cliMissing",
            message: "the AWS CLI (`aws`) was not found",
            hint: "Install AWS CLI v2, then try again.",
          };
        }
        sendProgress(channel, 0, {
          kind: "output",
          line: "Attempting to automatically open the SSO authorization page in your default browser.",
        });
        await new Promise((resolve) => setTimeout(resolve, options.loginDelayMs ?? 0));
        expiry[name] = Date.now() + 8 * HOUR;
        sendProgress(channel, 1, {
          kind: "output",
          line: "Successfully logged into Start URL: https://demo-corp.awsapps.com/start",
        });
        return null;
      }
      default:
        throw new Error(`fake backend: unknown command ${cmd}`);
    }
  };
}

/** Routes all `invoke` calls to a fresh fake backend. */
export function installFakeBackend(options?: FakeBackendOptions) {
  mockIPC(createFakeBackend(options));
}
