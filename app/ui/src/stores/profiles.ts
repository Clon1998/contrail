import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  commands,
  type ApiError,
  type CallerIdentity,
  type LoginProgress,
  type Profile,
  type SessionStatus,
} from "@/bindings";
import { initialProfile, needsLogin } from "@/lib/session";
import { usePrefs } from "./prefs";

/** The result of the "connected as …" check for the selected profile. */
export type IdentityState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; identity: CallerIdentity }
  | { state: "error"; error: ApiError };

/**
 * A running or finished SSO login: the lines `aws sso login` printed, or the page and code of the
 * built-in login (without the CLI).
 */
export interface LoginState {
  profile: string;
  running: boolean;
  lines: string[];
  device: { url: string; code: string } | null;
  error: ApiError | null;
}

interface ProfilesState {
  loading: boolean;
  loadError: ApiError | null;
  profiles: Profile[];
  statuses: Record<string, SessionStatus>;
  selected: string | null;
  identity: IdentityState;
  login: LoginState | null;
  /** Identities confirmed by STS, by profile name, with when (see `IDENTITY_FRESH_MS`). */
  confirmed: Record<string, { identity: CallerIdentity; at: number }>;

  /**
   * Reads all profiles and their session states, then selects the last used profile (from the
   * preferences) or a sensible first one.
   */
  load: () => Promise<void>;
  /** Re-reads the session states (local files only, cheap). */
  refreshStatuses: () => Promise<void>;
  select: (name: string) => Promise<void>;
  /** Saves the region override of the selected profile (`null` = the profile's region). */
  setRegion: (region: string | null) => Promise<void>;
  checkIdentity: () => Promise<void>;
  /**
   * An AWS call of the selected profile failed for want of valid credentials (the session ran
   * out or was revoked): the top bar offers to log in without waiting for the next check.
   */
  sessionRejected: (error: ApiError) => void;
  /** Logs in to the selected profile's SSO session, then re-checks the session. */
  startLogin: () => Promise<void>;
  dismissLogin: () => void;
}

/**
 * The region calls for profile `name` go to: the override from the region selector (saved in
 * the preferences), else the profile's own region.
 */
export function effectiveRegion(
  profiles: Profile[],
  regionOverrides: Record<string, string>,
  name: string,
): string | null {
  return regionOverrides[name] ?? profiles.find((p) => p.name === name)?.region ?? null;
}

/**
 * A profile confirmed less than this long ago is taken as connected when selected again, without
 * asking STS (switching between the tabs of two profiles shouldn't wait for it each time). A
 * session that ran out in between shows on the next AWS call (`sessionRejected`).
 */
export const IDENTITY_FRESH_MS = 10 * 60_000;

/** The region of the selected profile, as a hook (re-renders when it changes). */
export function useCurrentRegion(): string | null {
  const profiles = useProfiles((s) => s.profiles);
  const selected = useProfiles((s) => s.selected);
  const overrides = usePrefs((s) => s.prefs.regionOverrides);
  return selected ? effectiveRegion(profiles, overrides, selected) : null;
}

/** The region of the selected profile, for components and other stores. */
export function currentRegion(): string | null {
  const { profiles, selected } = useProfiles.getState();
  if (!selected) return null;
  return effectiveRegion(profiles, usePrefs.getState().prefs.regionOverrides, selected);
}

/** `confirmed` with the outcome of checking `name` (`null`: AWS rejected its session). */
function confirmedAfter(
  confirmed: ProfilesState["confirmed"],
  name: string,
  result: { status: "ok"; data: CallerIdentity } | { status: "error" } | null,
): ProfilesState["confirmed"] {
  const rest = Object.fromEntries(Object.entries(confirmed).filter(([k]) => k !== name));
  return result?.status === "ok"
    ? { ...rest, [name]: { identity: result.data, at: Date.now() } }
    : rest;
}

async function fetchStatuses(profiles: Profile[]): Promise<Record<string, SessionStatus>> {
  const entries = await Promise.all(
    profiles.map(async (p) => {
      const result = await commands.sessionStatus(p.name);
      return result.status === "ok" ? ([p.name, result.data] as const) : null;
    }),
  );
  return Object.fromEntries(entries.filter((e) => e !== null));
}

export const useProfiles = create<ProfilesState>((set, get) => ({
  loading: false,
  loadError: null,
  profiles: [],
  statuses: {},
  selected: null,
  identity: { state: "idle" },
  login: null,
  confirmed: {},

  load: async () => {
    set({ loading: true, loadError: null });
    await usePrefs.getState().load();
    const result = await commands.listProfiles();
    if (result.status === "error") {
      set({ loading: false, loadError: result.error });
      return;
    }
    const profiles = result.data;
    const statuses = await fetchStatuses(profiles);
    const known = (name: string | null) => name !== null && profiles.some((p) => p.name === name);
    const current = get().selected;
    const last = usePrefs.getState().prefs.lastProfile;
    set({ loading: false, profiles, statuses });
    const next = known(current) ? current : known(last) ? last : initialProfile(profiles, statuses);
    if (next) await get().select(next);
  },

  refreshStatuses: async () => {
    set({ statuses: await fetchStatuses(get().profiles) });
  },

  select: async (name) => {
    set({ selected: name, identity: { state: "idle" } });
    if (usePrefs.getState().prefs.lastProfile !== name) {
      void usePrefs.getState().setLastProfile(name);
    }
    const status = get().statuses[name];
    const profile = get().profiles.find((p) => p.name === name);
    // Don't call AWS when it can't work: the UI offers "Log in" instead.
    if (needsLogin(status) || profile?.auth.kind === "misconfigured") return;
    const known = get().confirmed[name];
    if (known && Date.now() - known.at < IDENTITY_FRESH_MS) {
      set({ identity: { state: "ok", identity: known.identity } });
      return;
    }
    await get().checkIdentity();
  },

  setRegion: async (region) => {
    const name = get().selected;
    if (name) await usePrefs.getState().setRegionOverride(name, region);
  },

  checkIdentity: async () => {
    const name = get().selected;
    if (!name) return;
    set({ identity: { state: "checking" } });
    const result = await commands.callerIdentity({ profile: name, region: currentRegion() });
    set((s) => ({ confirmed: confirmedAfter(s.confirmed, name, result) }));
    // The user may have switched profiles while the call was running.
    if (get().selected !== name) return;
    set({
      identity:
        result.status === "ok"
          ? { state: "ok", identity: result.data }
          : { state: "error", error: result.error },
    });
  },

  startLogin: async () => {
    const name = get().selected;
    if (!name || get().login?.running) return;
    set({ login: { profile: name, running: true, lines: [], device: null, error: null } });

    // Rust sends each line the CLI prints (or the built-in login's page and code) over this
    // channel while the command runs.
    const channel = new Channel<LoginProgress>((progress) => {
      const login = get().login;
      if (login?.profile !== name) return;
      if (progress.kind === "output") {
        set({ login: { ...login, lines: [...login.lines, progress.line] } });
      } else {
        set({ login: { ...login, device: { url: progress.url, code: progress.code } } });
      }
    });
    const result = await commands.ssoLogin(name, channel);

    const login = get().login;
    if (login?.profile === name) {
      set({
        login: { ...login, running: false, error: result.status === "error" ? result.error : null },
      });
    }
    await get().refreshStatuses();
    if (result.status === "ok" && get().selected === name) {
      await get().checkIdentity();
    }
  },

  sessionRejected: (error) => {
    const name = get().selected;
    if (!name) return;
    set((s) => ({ confirmed: confirmedAfter(s.confirmed, name, null) }));
    if (get().identity.state === "error") return;
    set({ identity: { state: "error", error } });
    void get().refreshStatuses();
  },

  dismissLogin: () => set({ login: null }),
}));
