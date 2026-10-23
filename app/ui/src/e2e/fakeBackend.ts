import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  AppInfo,
  AwsCtx,
  BufferStats,
  CallerIdentity,
  ClusterSummary,
  LogEvent,
  LogLocation,
  LogViewInfo,
  LoginProgress,
  Prefs,
  Profile,
  ServiceDetail,
  ServiceKey,
  ServiceRef,
  ServiceSummary,
  SessionStatus,
  Task,
} from "@/bindings";
import recorded from "./demo-ecs.json";
import recordedLogs from "./demo-logs.json";

/**
 * An in-memory stand-in for the Rust backend, mirroring demo mode (`contrail-fake`).
 *
 * Used by component tests and by the Playwright UI flows (`VITE_E2E=1`, see main.tsx), so the
 * UI can be exercised in a plain browser without Tauri or AWS. The ECS data is recorded from the
 * Rust fake (`demo-ecs.json`, written by `cargo test`), so both stay identical.
 */

/** The shape of `demo-ecs.json` (see app/src-tauri/src/demo_data.rs). */
interface RecordedEcs {
  recordedAt: string;
  account: string;
  region: string;
  clusters: ClusterSummary[];
  services: Record<string, ServiceSummary[]>;
  details: Record<string, ServiceDetail>;
  tasks: Record<string, Task[]>;
}

/** A whole string that is an ISO timestamp (not a log line that merely starts with one). */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Moves every timestamp in `value` by `deltaMs`, so "stopped 2m ago" stays true today. */
function shiftTimes<T>(value: T, deltaMs: number): T {
  if (typeof value === "string" && ISO_TIME.test(value)) {
    return new Date(Date.parse(value) + deltaMs).toISOString() as T;
  }
  if (Array.isArray(value)) return value.map((v: unknown) => shiftTimes(v, deltaMs)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, shiftTimes(v, deltaMs)]),
    ) as T;
  }
  return value;
}

/** The shape of `demo-logs.json` (see app/src-tauri/src/demo_data.rs). */
interface RecordedLogs {
  recordedAt: string;
  account: string;
  region: string;
  services: Record<
    string,
    {
      location: LogLocation;
      streams: number;
      stats: BufferStats;
      truncated: boolean;
      events: LogEvent[];
    }
  >;
}

/** The recorded landscape as seen from `account` in `region`, with times relative to now. */
function ecsData(account: string, region: string): RecordedEcs {
  const data = recorded as RecordedEcs;
  const relabeled = JSON.stringify(data)
    .replaceAll(data.account, account)
    .replaceAll(data.region, region);
  return shiftTimes(JSON.parse(relabeled) as RecordedEcs, Date.now() - Date.parse(data.recordedAt));
}

/** The recorded logs as seen from `account` in `region`, with times relative to now. */
function logsData(account: string, region: string): RecordedLogs {
  const data = recordedLogs as RecordedLogs;
  const relabeled = JSON.stringify(data)
    .replaceAll(data.account, account)
    .replaceAll(data.region, region);
  return shiftTimes(
    JSON.parse(relabeled) as RecordedLogs,
    Date.now() - Date.parse(data.recordedAt),
  );
}

function apiError(code: string, message: string, hint: string | null = null) {
  return { code, message, hint };
}

function serviceKey(profile: string, service: ServiceRef): ServiceKey {
  return {
    profile,
    region: service.clusterArn.split(":")[3] ?? "",
    clusterArn: service.clusterArn,
    serviceName: service.serviceName,
  };
}

function sameKey(a: ServiceKey, b: ServiceKey): boolean {
  return (
    a.profile === b.profile && a.clusterArn === b.clusterArn && a.serviceName === b.serviceName
  );
}

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
  /** Preferences to start with (default: none). */
  prefs?: Partial<Prefs>;
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

  let prefs: Prefs = {
    lastProfile: null,
    regionOverrides: {},
    favorites: [],
    recent: [],
    settings: {
      colorMode: "dark",
      accent: "sky",
      timeZone: "local",
      backfillMinutes: 15,
      uiScale: 100,
      logFontSize: 12,
      pauseWhenHidden: true,
      autoPauseMinutes: 10,
    },
    ...options.prefs,
  };

  /** What an AWS call would see: the account ID, or the error for unusable credentials. */
  function checkCredentials(ctx: AwsCtx): string {
    const profile = DEMO_PROFILES.find((p) => p.name === ctx.profile);
    if (!profile) throw apiError("config", `profile "${ctx.profile}" not found`);
    if (profile.auth.kind === "misconfigured") throw apiError("config", profile.auth.problem);
    const state = status(ctx.profile).state;
    if (state === "expired" || state === "loggedOut") {
      throw apiError(
        "credentials",
        `no valid credentials for profile "${ctx.profile}"`,
        `Log in again (aws sso login --profile ${ctx.profile}).`,
      );
    }
    return profile.auth.kind === "sso" ? profile.auth.accountId : "999988887777";
  }

  /** Open log views: their events by view ID (an array, or generated on demand). */
  const views = new Map<number, LogEvent[] | ((offset: number, limit: number) => LogEvent[])>();
  let nextViewId = 1;

  function ecs(ctx: AwsCtx): RecordedEcs {
    return ecsData(checkCredentials(ctx), ctx.region ?? "eu-central-1");
  }

  function serviceData(ctx: AwsCtx, service: ServiceRef) {
    const data = ecs(ctx);
    const cluster = service.clusterArn.split("/").at(-1);
    const key = `${cluster}/${service.serviceName}`;
    const detail = data.details[key];
    if (!detail) throw apiError("notFound", `service ${service.serviceName} not found`);
    return { detail, tasks: data.tasks[key] ?? [] };
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
        const account = checkCredentials(args?.ctx as AwsCtx);
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
      case "list_clusters":
        return ecs(args?.ctx as AwsCtx).clusters;
      case "list_services": {
        const services = ecs(args?.ctx as AwsCtx).services[args?.clusterArn as string];
        if (!services) throw apiError("notFound", "cluster not found");
        return services;
      }
      case "describe_service":
        return serviceData(args?.ctx as AwsCtx, args?.service as ServiceRef).detail;
      case "list_tasks": {
        const { tasks } = serviceData(args?.ctx as AwsCtx, args?.service as ServiceRef);
        return args?.includeStopped ? tasks : tasks.filter((t) => t.lastStatus !== "STOPPED");
      }
      case "open_service_logs": {
        const ctx = args?.ctx as AwsCtx;
        const service = args?.service as ServiceRef;
        const account = checkCredentials(ctx);
        serviceData(ctx, service); // not found → error
        const cluster = service.clusterArn.split("/").at(-1);
        const recordedService = logsData(account, ctx.region ?? "eu-central-1").services[
          `${cluster}/${service.serviceName}`
        ];
        const taskId = args?.taskId as string | null;
        const events = (recordedService?.events ?? []).filter(
          (e) => taskId === null || e.taskId === taskId,
        );
        const viewId = nextViewId++;
        // The high-volume demo service gets 100,000 generated events, for scrolling tests.
        const big = service.serviceName === "event-ingest";
        views.set(viewId, big ? generatedRows(service.serviceName) : events);
        const minutes = args?.minutes as number;
        const info: LogViewInfo = {
          viewId,
          location: recordedService?.location ?? {
            logGroup: `/ecs/${service.serviceName}`,
            region: null,
            streamPrefix: "ecs",
            container: service.serviceName,
          },
          streams: taskId !== null ? 1 : big ? 6 : (recordedService?.streams ?? 0),
          // The recording keeps a sample of the events; the counts describe all of them.
          stats: big
            ? {
                ...emptyStats(),
                total: BIG_VIEW,
                info: BIG_VIEW - BIG_VIEW / 50,
                warn: BIG_VIEW / 50,
              }
            : { ...(recordedService?.stats ?? emptyStats()), total: events.length },
          truncated: big || (recordedService?.truncated ?? false),
          from: new Date(Date.now() - minutes * 60_000).toISOString(),
          to: new Date().toISOString(),
        };
        return info;
      }
      case "get_log_rows": {
        const events = views.get(args?.viewId as number);
        if (!events) throw apiError("notFound", "log view is closed");
        const offset = args?.offset as number;
        const limit = args?.limit as number;
        return typeof events === "function"
          ? events(offset, limit)
          : events.slice(offset, offset + limit);
      }
      case "close_log_view":
        views.delete(args?.viewId as number);
        return null;
      case "get_prefs":
        return prefs;
      case "set_last_profile":
        prefs = { ...prefs, lastProfile: args?.profile as string };
        return prefs;
      case "set_region_override": {
        const profile = args?.profile as string;
        const region = args?.region as string | null;
        const others = Object.entries(prefs.regionOverrides).filter(([key]) => key !== profile);
        const regionOverrides: Record<string, string> = Object.fromEntries(others);
        if (region) regionOverrides[profile] = region;
        prefs = { ...prefs, regionOverrides };
        return prefs;
      }
      case "set_settings":
        prefs = { ...prefs, settings: args?.settings as Prefs["settings"] };
        return prefs;
      case "toggle_favorite": {
        const key = serviceKey(args?.profile as string, args?.service as ServiceRef);
        const pinned = prefs.favorites.some((f) => sameKey(f, key));
        prefs = {
          ...prefs,
          favorites: pinned
            ? prefs.favorites.filter((f) => !sameKey(f, key))
            : [...prefs.favorites, key],
        };
        return prefs;
      }
      case "add_recent": {
        const key = serviceKey(args?.profile as string, args?.service as ServiceRef);
        prefs = {
          ...prefs,
          recent: [key, ...prefs.recent.filter((r) => !sameKey(r, key))].slice(0, 10),
        };
        return prefs;
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

function emptyStats(): BufferStats {
  return { total: 0, evicted: 0, trace: 0, debug: 0, info: 0, warn: 0, error: 0, unknown: 0 };
}

/** Size of the generated high-volume view. */
const BIG_VIEW = 100_000;

/** 100,000 simple events, made only for the rows that are asked for. */
function generatedRows(service: string) {
  const start = Date.now() - BIG_VIEW * 9;
  return (offset: number, limit: number): LogEvent[] => {
    const rows: LogEvent[] = [];
    for (let i = offset; i < Math.min(offset + limit, BIG_VIEW); i++) {
      const timestamp = new Date(start + i * 9).toISOString();
      const warn = i % 50 === 0;
      rows.push({
        seq: i + 1,
        timestamp,
        cwTimestamp: timestamp,
        stream: `ecs/${service}/task${i % 6}`,
        taskId: `${(i % 6).toString().repeat(8)}aaaabbbbccccdddd00001111`,
        raw: `event ${i + 1}`,
        line: {
          kind: "ecs",
          timestamp,
          level: warn ? "WARN" : "INFO",
          message: `Ingested event #${i + 1} from example.events.v1`,
          fields: [{ key: "log.logger", value: "com.example.ingest.Consumer" }],
          error: null,
          jsonSpan: null,
        },
      });
    }
    return rows;
  };
}
