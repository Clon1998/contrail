import { create } from "zustand";
import {
  type FieldMapping,
  commands,
  type Prefs,
  type SearchEntry,
  type ServiceKey,
  type ServiceRef,
  type Settings,
  type Transformer,
} from "@/bindings";

/** Local preferences, kept by the Rust side (saved as JSON) and mirrored here. */
interface PrefsState {
  prefs: Prefs;
  load: () => Promise<void>;
  setLastProfile: (profile: string) => Promise<void>;
  setRegionOverride: (profile: string, region: string | null) => Promise<void>;
  toggleFavorite: (profile: string, service: ServiceRef) => Promise<void>;
  addRecent: (profile: string, service: ServiceRef) => Promise<void>;
  addNoise: (profile: string, service: ServiceRef, text: string) => Promise<void>;
  removeNoise: (profile: string, service: ServiceRef, text: string) => Promise<void>;
  setFieldMapping: (profile: string, service: ServiceRef, mapping: FieldMapping) => Promise<void>;
  /** What a transformer reads and writes (no topics removes it), for the route maps. */
  setTransformer: (service: string, transformer: Transformer) => Promise<void>;
  /** Changes some settings; the rest stay as they are. */
  updateSettings: (change: Partial<Settings>) => Promise<void>;
  /** Remembers a search run in a service's logs (history of the search box). */
  addSearch: (profile: string, service: ServiceRef, search: SearchEntry) => Promise<void>;
  clearSearchHistory: () => Promise<void>;
  /** Keeps a search under a name, for `service` or (with `null`) for every service. */
  saveSearch: (
    profile: string,
    service: ServiceRef | null,
    name: string,
    search: SearchEntry,
  ) => Promise<void>;
  deleteSavedSearch: (name: string, service: ServiceKey | null) => Promise<void>;
}

export const DEFAULT_SETTINGS: Settings = {
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
  wrapLines: false,
  showTimeline: true,
  builtinLogin: false,
  checkForUpdates: true,
};

export const EMPTY_PREFS: Prefs = {
  lastProfile: null,
  regionOverrides: {},
  favorites: [],
  recent: [],
  settings: DEFAULT_SETTINGS,
  noise: {},
  fieldMappings: {},
  transformers: {},
  lastUpdateCheck: null,
  searchHistory: { perService: {}, global: [] },
  savedSearches: [],
};

/** The key of a service's noise list (same as `ServiceKey::storage_key` in Rust). */
export function noiseKey(profile: string, service: ServiceRef): string {
  return `${profile}|${service.clusterArn}|${service.serviceName}`;
}

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
    addNoise: (profile, service, text) => apply(commands.addNoise(profile, service, text)),
    removeNoise: (profile, service, text) => apply(commands.removeNoise(profile, service, text)),
    setFieldMapping: (profile, service, mapping) =>
      apply(commands.setFieldMapping(profile, service, mapping)),
    setTransformer: (service, transformer) => apply(commands.setTransformer(service, transformer)),
    updateSettings: (change) => apply(commands.setSettings({ ...get().prefs.settings, ...change })),
    addSearch: (profile, service, search) => apply(commands.addSearch(profile, service, search)),
    clearSearchHistory: () => apply(commands.clearSearchHistory()),
    saveSearch: (profile, service, name, search) =>
      apply(commands.saveSearch(profile, service, name, search)),
    deleteSavedSearch: (name, service) => apply(commands.deleteSavedSearch(name, service)),
  };
});
