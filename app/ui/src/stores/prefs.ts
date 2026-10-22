import { create } from "zustand";
import { commands, type Prefs, type ServiceKey, type ServiceRef, type Settings } from "@/bindings";

/** Local preferences, kept by the Rust side (saved as JSON) and mirrored here. */
interface PrefsState {
  prefs: Prefs;
  load: () => Promise<void>;
  setLastProfile: (profile: string) => Promise<void>;
  setRegionOverride: (profile: string, region: string | null) => Promise<void>;
  toggleFavorite: (profile: string, service: ServiceRef) => Promise<void>;
  addRecent: (profile: string, service: ServiceRef) => Promise<void>;
  /** Changes some settings; the rest stay as they are. */
  updateSettings: (change: Partial<Settings>) => Promise<void>;
}

export const DEFAULT_SETTINGS: Settings = {
  colorMode: "dark",
  accent: "sky",
  timeZone: "local",
  backfillMinutes: 15,
  uiScale: 100,
  logFontSize: 12,
};

export const EMPTY_PREFS: Prefs = {
  lastProfile: null,
  regionOverrides: {},
  favorites: [],
  recent: [],
  settings: DEFAULT_SETTINGS,
};

/** Whether `key` refers to `service` of `profile`. */
export function isSameService(key: ServiceKey, profile: string, service: ServiceRef): boolean {
  return (
    key.profile === profile &&
    key.clusterArn === service.clusterArn &&
    key.serviceName === service.serviceName
  );
}

export const usePrefs = create<PrefsState>((set, get) => {
  /** Every change returns the saved preferences; on error the old ones stay. */
  async function apply(result: Promise<{ status: "ok"; data: Prefs } | { status: "error" }>) {
    const outcome = await result;
    if (outcome.status === "ok") set({ prefs: outcome.data });
  }

  return {
    prefs: EMPTY_PREFS,
    load: async () => set({ prefs: await commands.getPrefs() }),
    setLastProfile: (profile) => apply(commands.setLastProfile(profile)),
    setRegionOverride: (profile, region) => apply(commands.setRegionOverride(profile, region)),
    toggleFavorite: (profile, service) => apply(commands.toggleFavorite(profile, service)),
    addRecent: (profile, service) => apply(commands.addRecent(profile, service)),
    updateSettings: (change) => apply(commands.setSettings({ ...get().prefs.settings, ...change })),
  };
});
