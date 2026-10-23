import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  FilterResult,
  FilterSpec,
  Level,
  AppInfo,
  LiveState,
  LiveUpdate,
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
  /** How often live tails add an event (default: every second). */
  liveIntervalMs?: number;
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
    sendOnChannel(channel, index, message);
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
    noise: {},
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

  /** Live tails by view ID: the timer adding events, and the channel's message counter. */
  const tails = new Map<
    number,
    { channel: { id: number }; sent: number; timer?: ReturnType<typeof setInterval> }
  >();

  /** Files "saved" through the export dialog. */
  const exports: { path: string; format?: string; count?: number }[] = [];

  /** Searches per view: the spec and the indices of matching events. */
  const filters = new Map<number, { spec: FilterSpec; matched: number[] }>();

  /** The events a view lists: the matches when filtering, all otherwise. */
  function listed(
    viewId: number,
  ): LogEvent[] | ((offset: number, limit: number) => LogEvent[]) | undefined {
    const events = views.get(viewId);
    const filter = filters.get(viewId);
    if (!Array.isArray(events) || !filter || filter.spec.mode !== "filter") return events;
    return filter.matched.map((i) => events[i]).filter((e): e is LogEvent => e !== undefined);
  }

  /** Current size of generated views (they grow while live). */
  const bigCounts = new Map<number, number>();

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

  /** Sends a live update for a view: its state and counts, and which rows changed. */
  function sendLive(viewId: number, state: LiveState, firstChanged: number | null) {
    const tail = tails.get(viewId);
    const events = views.get(viewId);
    if (!tail || events === undefined) return;
    const total =
      typeof events === "function" ? (bigCounts.get(viewId) ?? BIG_VIEW) : events.length;
    const filter = filters.get(viewId);
    if (filter && Array.isArray(events)) {
      // Check the events added since the search was set (or last checked).
      const compiled = compileQuery(filter.spec.query);
      const from = (filter.matched.at(-1) ?? -1) + 1;
      for (let i = from; i < events.length; i++) {
        const e = events[i];
        if (e && "test" in compiled && compiled.test(e, filter.spec.searchRaw)) {
          filter.matched.push(i);
        }
      }
    }
    const visible = filter?.spec.mode === "filter" ? filter.matched.length : total;
    const update: LiveUpdate = {
      state,
      sampled: false,
      stats: Array.isArray(events) ? statsOf(events) : { ...emptyStats(), total, info: total },
      visible,
      matches: filter ? filter.matched.length : null,
      firstChanged,
      evicted: 0,
      message: null,
    };
    sendOnChannel(tail.channel, tail.sent++, update);
  }

  /** Every second, appends copies of a view's first events with fresh timestamps. */
  function startTail(viewId: number) {
    const tail = tails.get(viewId);
    if (!tail || tail.timer) return;
    sendLive(viewId, "live", null);
    tail.timer = setInterval(() => {
      const events = views.get(viewId);
      if (typeof events === "function") {
        const count = bigCounts.get(viewId) ?? BIG_VIEW;
        bigCounts.set(viewId, count + 1);
        return sendLive(viewId, "live", count);
      }
      if (!events || events.length === 0) return sendLive(viewId, "live", null);
      const template = events[events.length % Math.min(events.length, 25)] ?? events[0];
      if (!template) return;
      const now = new Date().toISOString();
      const first = events.length;
      events.push({
        ...template,
        seq: (events.at(-1)?.seq ?? 0) + 1,
        timestamp: now,
        cwTimestamp: now,
        line: { ...template.line, timestamp: now },
      });
      sendLive(viewId, "live", first);
    }, options.liveIntervalMs ?? 1_000);
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
        if (big) bigCounts.set(viewId, BIG_VIEW);
        views.set(
          viewId,
          big
            ? generatedRows(service.serviceName, () => bigCounts.get(viewId) ?? BIG_VIEW)
            : events,
        );
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
        const rows = listed(args?.viewId as number);
        if (Array.isArray(rows)) return rows.slice(offset, offset + limit);
        return typeof events === "function"
          ? events(offset, limit)
          : events.slice(offset, offset + limit);
      }
      case "set_log_filter": {
        const viewId = args?.viewId as number;
        const spec = args?.spec as FilterSpec;
        const compiled = compileQuery(spec.query);
        if ("error" in compiled) {
          return { kind: "invalid", error: compiled.error } satisfies FilterResult;
        }
        const events = views.get(viewId);
        const trivial =
          spec.query.trim() === "" && spec.hiddenLevels.length === 0 && spec.noise.length === 0;
        if (trivial || !Array.isArray(events)) {
          filters.delete(viewId);
          const visible = Array.isArray(events)
            ? events.length
            : (bigCounts.get(viewId) ?? BIG_VIEW);
          return {
            kind: "applied",
            visible,
            matches: null,
            highlightTerms: [],
          } satisfies FilterResult;
        }
        const accepts = (e: LogEvent) =>
          !(e.line.level && spec.hiddenLevels.includes(e.line.level)) &&
          !spec.noise.some((n) => e.line.message.toLowerCase().includes(n.toLowerCase())) &&
          compiled.test(e, spec.searchRaw);
        const matched = events.flatMap((e, i) => (accepts(e) ? [i] : []));
        filters.set(viewId, { spec, matched });
        return {
          kind: "applied",
          visible: spec.mode === "filter" ? matched.length : events.length,
          matches: matched.length,
          highlightTerms: compiled.terms,
        } satisfies FilterResult;
      }
      case "get_match_positions": {
        const filter = filters.get(args?.viewId as number);
        if (!filter) return [];
        return filter.spec.mode === "highlight" ? filter.matched : filter.matched.map((_, i) => i);
      }
      case "plugin:dialog|save": {
        const options = args?.options as { defaultPath?: string } | undefined;
        exports.push({ path: `/tmp/${options?.defaultPath ?? "export"}` });
        return exports.at(-1)?.path;
      }
      case "export_log_view": {
        const rows = listed(args?.viewId as number);
        const count = Array.isArray(rows)
          ? rows.length
          : (bigCounts.get(args?.viewId as number) ?? BIG_VIEW);
        const last = exports.at(-1);
        if (last) Object.assign(last, { format: args?.format as string, count });
        return count;
      }
      case "close_log_view": {
        const viewId = args?.viewId as number;
        views.delete(viewId);
        filters.delete(viewId);
        bigCounts.delete(viewId);
        clearInterval(tails.get(viewId)?.timer);
        tails.delete(viewId);
        return null;
      }
      case "start_live": {
        const viewId = args?.viewId as number;
        const tail = { channel: args?.onUpdate as { id: number }, sent: 0 };
        tails.set(viewId, tail);
        startTail(viewId);
        return null;
      }
      case "pause_live": {
        const viewId = args?.viewId as number;
        const tail = tails.get(viewId);
        if (tail) {
          clearInterval(tail.timer);
          tail.timer = undefined;
          sendLive(viewId, "paused", null);
        }
        return null;
      }
      case "resume_live":
        startTail(args?.viewId as number);
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
      case "add_noise":
      case "remove_noise": {
        const service = args?.service as ServiceRef;
        const key = `${args?.profile as string}|${service.clusterArn}|${service.serviceName}`;
        const text = (args?.text as string).trim();
        const list = (prefs.noise[key] ?? []).filter((n) => n !== text);
        if (cmd === "add_noise" && text) list.push(text);
        const others = Object.entries(prefs.noise).filter(([k]) => k !== key);
        const noise: Record<string, string[]> = Object.fromEntries(others);
        if (list.length > 0) noise[key] = list;
        prefs = { ...prefs, noise };
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

/** Simple events (100,000 at first), made only for the rows that are asked for. */
function generatedRows(service: string, count: () => number) {
  const start = Date.now() - BIG_VIEW * 9;
  return (offset: number, limit: number): LogEvent[] => {
    const rows: LogEvent[] = [];
    for (let i = offset; i < Math.min(offset + limit, count()); i++) {
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

/** Delivers a message on a (mocked) Tauri channel, as the Rust side would. */
function sendOnChannel(channel: { id: number }, index: number, message: unknown) {
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void };
    }
  ).__TAURI_INTERNALS__;
  internals.runCallback(channel.id, { index, message });
}

const LEVELS: Level[] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];

type FakeTest = (e: LogEvent, raw: boolean) => boolean;

/**
 * A simplified version of the Rust query language (crates/contrail-core/src/query.rs) for the
 * UI tests: text, "phrases", level:X / level>=X, field:value (* globs), -negation.
 */
function compileQuery(
  query: string,
):
  | { test: FakeTest; terms: string[] }
  | { error: { message: string; start: number; end: number; hint: string | null } } {
  const tests: FakeTest[] = [];
  const terms: string[] = [];
  for (const match of query.matchAll(/(-?)("[^"]*"?|\S+)/g)) {
    const negation = match[1] ?? "";
    const rawToken = match[2] ?? "";
    const start = match.index;
    if (rawToken.startsWith('"') && (rawToken.length === 1 || !rawToken.endsWith('"'))) {
      return {
        error: {
          message: "unterminated quote",
          start,
          end: query.length,
          hint: 'Close the phrase with "',
        },
      };
    }
    const token = rawToken.replace(/^"|"$/g, "");
    let test: FakeTest;
    const level = /^level(:|>=|<=|>|<)(\w+)$/i.exec(rawToken);
    const field = /^([A-Za-z@][\w.@-]*):(.+)$/.exec(rawToken);
    if (level) {
      const op = level[1] ?? ":";
      const wanted = LEVELS.indexOf((level[2] ?? "").toUpperCase() as Level);
      if (wanted === -1) {
        return {
          error: {
            message: `unknown level "${level[2]}"`,
            start: start + negation.length + 5 + op.length,
            end: start + match[0].length,
            hint: "Levels: TRACE, DEBUG, INFO, WARN, ERROR",
          },
        };
      }
      test = (e) => {
        if (!e.line.level) return false;
        const actual = LEVELS.indexOf(e.line.level);
        if (op === ":") return actual === wanted;
        if (op === ">=") return actual >= wanted;
        if (op === ">") return actual > wanted;
        if (op === "<=") return actual <= wanted;
        return actual < wanted;
      };
    } else if (field) {
      const key = field[1] ?? "";
      const value = field[2] ?? "";
      const escaped = value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "i");
      test = (e) => {
        const found = e.line.fields.find((f) => f.key === key)?.value;
        return found !== undefined && found !== null && pattern.test(String(found));
      };
    } else {
      const needle = token.toLowerCase();
      if (!negation) terms.push(needle);
      test = (e, raw) => (raw ? e.raw : e.line.message).toLowerCase().includes(needle);
    }
    tests.push(negation ? (e, raw) => !test(e, raw) : test);
  }
  return { test: (e, raw) => tests.every((t) => t(e, raw)), terms };
}

/** Level counts of a list of events, as the Rust buffer reports them. */
function statsOf(events: LogEvent[]): BufferStats {
  const stats = { ...emptyStats(), total: events.length };
  for (const e of events) {
    const level = e.line.level;
    if (level === null) stats.unknown++;
    else stats[level.toLowerCase() as Lowercase<Level>]++;
  }
  return stats;
}
