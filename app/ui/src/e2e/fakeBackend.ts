import type { InvokeArgs } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type {
  FieldMapping,
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
  TimeWindow,
  OlderEvents,
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
  /** The first this many live tail starts fail with an expired session. */
  liveFailures?: number;
  /** Profiles whose session looks valid locally but is rejected by AWS until the next login. */
  rejectedSessions?: string[];
  /** Delay of row fetches, like the real IPC round trip (default: none). */
  rowsDelayMs?: number;
  /** Delay of `load_older` (default: none). */
  olderDelayMs?: number;
}

/**
 * Creates the IPC handler. Each call starts from the initial demo state. `stop()` ends all live
 * tails.
 */
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
      bufferSize: 100_000,
      logColumns: [],
      newestFirst: false,
    },
    noise: {},
    fieldMappings: {},
    ...options.prefs,
  };

  const rejected = new Set(options.rejectedSessions);

  /** What an AWS call would see: the account ID, or the error for unusable credentials. */
  function checkCredentials(ctx: AwsCtx): string {
    const profile = DEMO_PROFILES.find((p) => p.name === ctx.profile);
    if (!profile) throw apiError("config", `profile "${ctx.profile}" not found`);
    if (profile.auth.kind === "misconfigured") throw apiError("config", profile.auth.problem);
    const state = status(ctx.profile).state;
    if (state === "expired" || state === "loggedOut" || rejected.has(ctx.profile)) {
      throw apiError(
        "credentials",
        `no valid credentials for profile "${ctx.profile}": Session token not found or invalid`,
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
  const filters = new Map<
    number,
    {
      spec: FilterSpec;
      accepts: (e: LogEvent) => boolean;
      matched: number[];
      /** Events before this index have been checked. */
      checked: number;
    }
  >();

  /** The events a view lists: the matches when filtering, all otherwise. */
  function listed(
    viewId: number,
  ): LogEvent[] | ((offset: number, limit: number) => LogEvent[]) | undefined {
    const events = views.get(viewId);
    const filter = filters.get(viewId);
    if (!Array.isArray(events) || !filter || filter.spec.mode !== "filter") return events;
    return filter.matched.map((i) => events[i]).filter((e): e is LogEvent => e !== undefined);
  }

  /** The listed rows of a view from `first` on (at most 500). */
  function changedRows(viewId: number, first: number): LogEvent[] {
    const rows = listed(viewId);
    if (rows === undefined) return [];
    return typeof rows === "function" ? rows(first, 500) : rows.slice(first, first + 500);
  }

  /** The start of each view's time window (`load_older` loads up to it). */
  const windowStarts = new Map<number, string>();

  /** Events a view holds back until `load_older` (long windows start with the newest). */
  const olderPending = new Map<number, LogEvent[]>();

  /** How many rows a view lists (all events, or the matches when filtering). */
  function listedCount(viewId: number): number {
    const rows = listed(viewId);
    if (Array.isArray(rows)) return rows.length;
    return bigVisible(viewId);
  }

  /** Generated views of long windows hide their older half until `load_older`. */
  const bigHidden = new Map<number, number>();

  /** How many rows a generated view lists. */
  function bigVisible(viewId: number): number {
    return (bigCounts.get(viewId) ?? BIG_VIEW) - (bigHidden.get(viewId) ?? 0);
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
  function sendLive(
    viewId: number,
    state: LiveState,
    firstChanged: number | null,
    message: string | null = null,
  ) {
    const tail = tails.get(viewId);
    const events = views.get(viewId);
    if (!tail || events === undefined) return;
    const total = typeof events === "function" ? bigVisible(viewId) : events.length;
    const filter = filters.get(viewId);
    if (filter && Array.isArray(events)) {
      // Check the events added since the search was set (or last checked).
      for (let i = filter.checked; i < events.length; i++) {
        const e = events[i];
        if (e && filter.accepts(e)) filter.matched.push(i);
      }
      filter.checked = events.length;
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
      // Like the Rust side: a few changed rows travel with the update.
      rows:
        firstChanged !== null && visible - firstChanged <= 500
          ? changedRows(viewId, firstChanged)
          : [],
      message,
    };
    sendOnChannel(tail.channel, tail.sent++, update);
  }

  /** Every second, appends copies of a view's first events with fresh timestamps. */
  let liveFailures = options.liveFailures ?? 0;

  function startTail(viewId: number) {
    const tail = tails.get(viewId);
    if (!tail || tail.timer) return;
    if (liveFailures > 0) {
      liveFailures--;
      const message = 'no valid credentials for profile "demo-dev": ExpiredToken';
      return sendLive(viewId, "failed", null, message);
    }
    sendLive(viewId, "live", null);
    tail.timer = setInterval(() => {
      const events = views.get(viewId);
      if (typeof events === "function") {
        bigCounts.set(viewId, (bigCounts.get(viewId) ?? BIG_VIEW) + 1);
        return sendLive(viewId, "live", bigVisible(viewId) - 1);
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

  const handler = async (cmd: string, payload?: InvokeArgs): Promise<unknown> => {
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
        rejected.delete(name);
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
      case "reveal_secret": {
        checkCredentials(args?.ctx as AwsCtx);
        const name = (args?.valueFrom as string).split("/").at(-1);
        return `demo-${name}-not-a-real-secret`;
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
        const mapping =
          prefs.fieldMappings[`${ctx.profile}|${service.clusterArn}|${service.serviceName}`];
        const events = (recordedService?.events ?? [])
          .filter((e) => taskId === null || e.taskId === taskId)
          .map((e) => (mapping ? applyMapping(e, mapping) : e));
        const viewId = nextViewId++;
        const timeWindow = args?.window as TimeWindow;
        // The high-volume demo service gets 100,000 generated events, for scrolling tests.
        const big = service.serviceName === "event-ingest";
        if (big) bigCounts.set(viewId, BIG_VIEW);
        // Like the Rust side, long windows start with the newest events: here the newer half,
        // the older half comes with `load_older`.
        const long = timeWindow.kind === "range" || timeWindow.minutes > 15;
        const half = long ? Math.floor((big ? BIG_VIEW : events.length) / 2) : 0;
        if (half > 0 && big) bigHidden.set(viewId, half);
        else if (half > 0) olderPending.set(viewId, events.slice(0, half));
        views.set(
          viewId,
          big
            ? generatedRows(
                service.serviceName,
                () => bigCounts.get(viewId) ?? BIG_VIEW,
                () => bigHidden.get(viewId) ?? 0,
              )
            : events.slice(half),
        );
        const to = timeWindow.kind === "range" ? timeWindow.to : new Date().toISOString();
        const from =
          timeWindow.kind === "range"
            ? timeWindow.from
            : new Date(Date.now() - timeWindow.minutes * 60_000).toISOString();
        windowStarts.set(viewId, from);
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
            ? bigStats(BIG_VIEW - half)
            : half > 0 && !big
              ? statsOf(events.slice(half))
              : { ...(recordedService?.stats ?? emptyStats()), total: events.length },
          truncated: big || (recordedService?.truncated ?? false),
          from,
          to,
          loadedFrom: half > 0 ? (events[half]?.cwTimestamp ?? from) : from,
          complete: half === 0,
        };
        return info;
      }
      case "load_older": {
        if (options.olderDelayMs) await new Promise((r) => setTimeout(r, options.olderDelayMs));
        const viewId = args?.viewId as number;
        const events = views.get(viewId);
        if (!events) throw apiError("notFound", "log view is closed");
        const before = listedCount(viewId);
        const older = olderPending.get(viewId) ?? [];
        olderPending.delete(viewId);
        bigHidden.delete(viewId);
        if (Array.isArray(events) && older.length > 0) {
          const all = [...older, ...events];
          views.set(viewId, all);
          const filter = filters.get(viewId);
          if (filter) {
            filter.matched = all.flatMap((e, i) => (filter.accepts(e) ? [i] : []));
            filter.checked = all.length;
          }
        }
        const visible = listedCount(viewId);
        const added = visible - before;
        const rowsFrom = Math.max(0, added - 300);
        const rows = listed(viewId);
        const now = views.get(viewId);
        return {
          added,
          visible,
          matches: filters.get(viewId)?.matched.length ?? null,
          stats: Array.isArray(now) ? statsOf(now) : bigStats(bigVisible(viewId)),
          loadedFrom: windowStarts.get(viewId) ?? new Date().toISOString(),
          complete: true,
          full: false,
          rowsFrom,
          rows: Array.isArray(rows)
            ? rows.slice(rowsFrom, added + 300)
            : (rows?.(rowsFrom, added + 300 - rowsFrom) ?? []),
        } satisfies OlderEvents;
      }
      case "get_log_rows": {
        if (options.rowsDelayMs) await new Promise((r) => setTimeout(r, options.rowsDelayMs));
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
        const compiled = spec.regex ? compileRegex(spec.query) : compileQuery(spec.query);
        if ("error" in compiled) {
          return { kind: "invalid", error: compiled.error } satisfies FilterResult;
        }
        const events = views.get(viewId);
        const trivial =
          spec.query.trim() === "" && spec.hiddenLevels.length === 0 && spec.noise.length === 0;
        if (trivial || !Array.isArray(events)) {
          filters.delete(viewId);
          const visible = Array.isArray(events) ? events.length : bigVisible(viewId);
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
        filters.set(viewId, { spec, accepts, matched, checked: events.length });
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
        const count = Array.isArray(rows) ? rows.length : bigVisible(args?.viewId as number);
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
        if (args?.paused) sendLive(viewId, "paused", null);
        else startTail(viewId);
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
      case "set_field_mapping": {
        const service = args?.service as ServiceRef;
        const key = `${args?.profile as string}|${service.clusterArn}|${service.serviceName}`;
        const mapping = args?.mapping as FieldMapping;
        const others = Object.entries(prefs.fieldMappings).filter(([k]) => k !== key);
        const fieldMappings: Record<string, FieldMapping> = Object.fromEntries(others);
        if (mapping.message || mapping.level || mapping.timestamp) fieldMappings[key] = mapping;
        prefs = { ...prefs, fieldMappings };
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
  const stop = () => tails.forEach((tail) => clearInterval(tail.timer));
  return Object.assign(handler, { stop });
}

/** Stops the installed backend's live tail timers (see `uninstallFakeBackend`). */
let stopInstalled: (() => void) | null = null;

/** Routes all `invoke` calls to a fresh fake backend. */
export function installFakeBackend(options?: FakeBackendOptions) {
  const backend = createFakeBackend(options);
  stopInstalled = backend.stop;
  mockIPC(backend);
}

/**
 * Removes the mocked IPC after a test. Live tails still running (a test may end with a view
 * open) are stopped first: their timers would otherwise fire into the next test without IPC.
 */
export function uninstallFakeBackend() {
  stopInstalled?.();
  stopInstalled = null;
  clearMocks();
}

/** Counts of a generated view with `total` events (every 50th is a WARN). */
function bigStats(total: number): BufferStats {
  const warn = Math.ceil(total / 50);
  return { ...emptyStats(), total, info: total - warn, warn };
}

function emptyStats(): BufferStats {
  return { total: 0, evicted: 0, trace: 0, debug: 0, info: 0, warn: 0, error: 0, unknown: 0 };
}

/** Size of the generated high-volume view. */
const BIG_VIEW = 100_000;

/** Simple events (100,000 at first), made only for the rows that are asked for. */
function generatedRows(service: string, count: () => number, hidden: () => number = () => 0) {
  const start = Date.now() - BIG_VIEW * 9;
  return (offset: number, limit: number): LogEvent[] => {
    const rows: LogEvent[] = [];
    // Listed row `j` is event `j + hidden()` (the hidden ones are the oldest).
    for (let i = offset + hidden(); i < Math.min(offset + hidden() + limit, count()); i++) {
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
/** Regex mode: the whole query is one case-insensitive JavaScript regex (close enough here). */
function compileRegex(query: string): ReturnType<typeof compileQuery> {
  try {
    const regex = new RegExp(query, "i");
    return { test: (e, raw) => regex.test(raw ? e.raw : e.line.message), terms: [] };
  } catch {
    return {
      error: { message: "invalid regular expression", start: 0, end: query.length, hint: null },
    };
  }
}

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

/** The message and level parts of the Rust field mapping (crates/contrail-core/src/logs/mapping.rs). */
function applyMapping(event: LogEvent, mapping: FieldMapping): LogEvent {
  const value = (key: string | null) =>
    key ? event.line.fields.find((f) => f.key === key)?.value : undefined;
  const message = value(mapping.message);
  const level = value(mapping.level);
  const parsedLevel = LEVELS.find((l) => l === String(level).toUpperCase());
  return {
    ...event,
    line: {
      ...event.line,
      message: message === undefined ? event.line.message : String(message),
      fields:
        message === undefined
          ? event.line.fields
          : [
              { key: "message", value: event.line.message },
              ...event.line.fields.filter((f) => f.key !== mapping.message),
            ],
      level: parsedLevel ?? event.line.level,
    },
  };
}
