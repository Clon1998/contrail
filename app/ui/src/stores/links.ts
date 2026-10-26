import { create } from "zustand";
import { commands, type ViewLink } from "@/bindings";
import { useEcs } from "./ecs";
import { currentRegion, useProfiles } from "./profiles";
import { useTabs } from "./tabs";

/** Why a shared link can't be opened, said so the reader can fix it. */
export interface LinkProblem {
  message: string;
  hint: string | null;
}

interface LinksState {
  /** A link waiting for its profile to be connected (logged in, region switched). */
  pending: ViewLink | null;
  problem: LinkProblem | null;
  /** Opens a `contrail://` link: switches to its profile and region, then shows its view. */
  open: (url: string) => Promise<void>;
  dismiss: () => void;
}

/** The profile and region a link's view lives in, as the ECS store keys them. */
export function linkCtxKey(link: ViewLink): string {
  const own = useProfiles.getState().profiles.find((p) => p.name === link.profile)?.region;
  return `${link.profile}|${link.region ?? own ?? ""}`;
}

export const useLinks = create<LinksState>((set) => ({
  pending: null,
  problem: null,

  open: async (url) => {
    const parsed = await commands.parseViewLink(url);
    if (parsed.status === "error") {
      set({ pending: null, problem: { message: parsed.error.message, hint: parsed.error.hint } });
      return;
    }
    const link = parsed.data;
    const profiles = useProfiles.getState();
    const profile = profiles.profiles.find((p) => p.name === link.profile);
    if (!profile) {
      set({
        pending: null,
        problem: {
          message: `This link is for the AWS profile "${link.profile}", which isn't in your AWS config.`,
          hint: `Add a profile of that name for the same account (ask whoever sent the link for its settings), then open the link again. Service: ${link.serviceName}.`,
        },
      });
      return;
    }
    set({ pending: link, problem: null });
    if (profiles.selected !== link.profile) await profiles.select(link.profile);
    // The link's region, unless it is the profile's own (then no override).
    const wanted = link.region ?? profile.region;
    if (wanted && currentRegion() !== wanted) {
      await useProfiles.getState().setRegion(wanted === profile.region ? null : wanted);
    }
  },

  dismiss: () => set({ pending: null, problem: null }),
}));

/**
 * Shows the view of a pending link once its profile and region are the ones browsed: opens the
 * service in its tab with the link's time window, task and search, on the Logs tab.
 */
export async function applyPendingLink() {
  const link = useLinks.getState().pending;
  const ctx = useEcs.getState().ctx;
  if (!link || !ctx || `${ctx.profile}|${ctx.region ?? ""}` !== linkCtxKey(link)) return;
  useLinks.setState({ pending: null });
  const service = { clusterArn: link.clusterArn, serviceName: link.serviceName };
  await useEcs.getState().openService(service);
  useTabs.getState().activate(service);
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((t) => t.key === tabs.activeKey);
  if (tab?.kind !== "service") return;
  // Set before the Logs tab mounts: its view opens with this window and task.
  const logs = tab.logs.getState();
  logs.setWindow(link.window);
  if (link.taskId) logs.showTask(service, link.taskId);
  logs.setTab("logs");
  if (link.search) {
    await logs.setSearch({
      query: link.search.query,
      mode: link.search.mode,
      regex: link.search.regex,
      raw: link.search.raw,
    });
  }
}
