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

/** The result of the "connected as …" check for the selected profile. */
export type IdentityState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; identity: CallerIdentity }
  | { state: "error"; error: ApiError };

/** A running or finished `aws sso login`, with the lines it printed. */
export interface LoginState {
  profile: string;
  running: boolean;
  lines: string[];
  error: ApiError | null;
}

interface ProfilesState {
  loading: boolean;
  loadError: ApiError | null;
  profiles: Profile[];
  statuses: Record<string, SessionStatus>;
  selected: string | null;
  /** Region chosen in the region selector, per profile (overrides the profile's region). */
  regionOverrides: Record<string, string>;
  identity: IdentityState;
  login: LoginState | null;

  /** Reads all profiles and their session states, then selects the initial profile. */
  load: () => Promise<void>;
  /** Re-reads the session states (local files only, cheap). */
  refreshStatuses: () => Promise<void>;
  select: (name: string) => Promise<void>;
  setRegion: (region: string | null) => void;
  checkIdentity: () => Promise<void>;
  /** Runs `aws sso login` for the selected profile, then re-checks the session. */
  startLogin: () => Promise<void>;
  dismissLogin: () => void;
}

/** The region calls for `name` go to: the override, else the profile's own region. */
export function effectiveRegion(
  state: Pick<ProfilesState, "profiles" | "regionOverrides">,
  name: string,
): string | null {
  return state.regionOverrides[name] ?? state.profiles.find((p) => p.name === name)?.region ?? null;
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
  regionOverrides: {},
  identity: { state: "idle" },
  login: null,

  load: async () => {
    set({ loading: true, loadError: null });
    const result = await commands.listProfiles();
    if (result.status === "error") {
      set({ loading: false, loadError: result.error });
      return;
    }
    const profiles = result.data;
    const statuses = await fetchStatuses(profiles);
    const current = get().selected;
    const keep = current !== null && profiles.some((p) => p.name === current);
    set({ loading: false, profiles, statuses });
    const next = keep ? current : initialProfile(profiles, statuses);
    if (next) await get().select(next);
  },

  refreshStatuses: async () => {
    set({ statuses: await fetchStatuses(get().profiles) });
  },

  select: async (name) => {
    set({ selected: name, identity: { state: "idle" } });
    const status = get().statuses[name];
    const profile = get().profiles.find((p) => p.name === name);
    // Don't call AWS when it can't work: the UI offers "Log in" instead.
    if (needsLogin(status) || profile?.auth.kind === "misconfigured") return;
    await get().checkIdentity();
  },

  setRegion: (region) => {
    const name = get().selected;
    if (!name) return;
    // Build a new object instead of mutating: zustand detects changes by reference.
    const others = Object.entries(get().regionOverrides).filter(([key]) => key !== name);
    const regionOverrides: Record<string, string> = Object.fromEntries(others);
    if (region) regionOverrides[name] = region;
    set({ regionOverrides });
  },

  checkIdentity: async () => {
    const name = get().selected;
    if (!name) return;
    set({ identity: { state: "checking" } });
    const result = await commands.callerIdentity({
      profile: name,
      region: effectiveRegion(get(), name),
    });
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
    set({ login: { profile: name, running: true, lines: [], error: null } });

    // Rust sends each line the CLI prints over this channel while the command runs.
    const channel = new Channel<LoginProgress>((progress) => {
      const login = get().login;
      if (login?.profile === name) {
        set({ login: { ...login, lines: [...login.lines, progress.line] } });
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

  dismissLogin: () => set({ login: null }),
}));
