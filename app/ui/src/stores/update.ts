import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { commands, type ApiError, type UpdateInfo, type UpdateProgress } from "@/bindings";

/** Where the update is. */
export type UpdatePhase = "idle" | "checking" | "downloading" | "installing";

interface UpdateState {
  /** The newer version found by the last check, if any. */
  available: UpdateInfo | null;
  phase: UpdatePhase;
  /** Download progress, while downloading (`total` is null when the server doesn't say). */
  progress: UpdateProgress | null;
  /** The result of "Check now", for the settings ("up to date" or what went wrong). */
  checked: { upToDate: boolean; error: ApiError | null } | null;
  error: ApiError | null;
  dialogOpen: boolean;
  /** The check on start: quiet, at most once a day (Rust decides), never in dev builds. */
  checkOnStart: () => Promise<void>;
  /** "Check now" in the settings: opens the dialog when there is an update. */
  checkNow: () => Promise<void>;
  /** Downloads, installs and restarts; resolves only if that failed or was cancelled. */
  install: () => Promise<void>;
  cancel: () => void;
  setDialogOpen: (open: boolean) => void;
}

export const useUpdate = create<UpdateState>((set, get) => ({
  available: null,
  phase: "idle",
  progress: null,
  checked: null,
  error: null,
  dialogOpen: false,

  checkOnStart: async () => {
    const result = await commands.checkForUpdate(false);
    if (result.status === "ok" && result.data) set({ available: result.data });
  },

  checkNow: async () => {
    if (get().phase !== "idle") return;
    set({ phase: "checking", checked: null });
    const result = await commands.checkForUpdate(true);
    if (result.status === "error") {
      set({ phase: "idle", checked: { upToDate: false, error: result.error } });
      return;
    }
    const available = result.data;
    set({
      phase: "idle",
      available,
      checked: { upToDate: available === null, error: null },
      dialogOpen: available !== null,
    });
  },

  install: async () => {
    if (get().phase !== "idle") return;
    set({ phase: "downloading", progress: null, error: null });
    const channel = new Channel<UpdateProgress>((progress) => {
      const done = progress.total !== null && progress.downloaded >= progress.total;
      set({ progress, phase: done ? "installing" : "downloading" });
    });
    // On success Contrail restarts and this never returns.
    const result = await commands.installUpdate(channel);
    if (result.status === "error" && result.error.code !== "cancelled")
      set({ error: result.error });
    set({ phase: "idle", progress: null });
  },

  cancel: () => void commands.cancelUpdate(),
  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
}));
