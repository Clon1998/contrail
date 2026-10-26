import { useEffect, useState } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { commands, type AppInfo } from "@/bindings";
import { ServicePalette } from "@/components/ecs/ServicePalette";
import { ServiceView } from "@/components/ecs/ServiceView";
import { Sidebar } from "@/components/ecs/Sidebar";
import { ConnectionPanel } from "@/components/profile/ConnectionPanel";
import { LinkNotice } from "@/components/profile/LinkNotice";
import { LoginOutput } from "@/components/profile/LoginOutput";
import { ProfileBar } from "@/components/profile/ProfileBar";
import { useAppearance } from "@/hooks/useAppearance";
import { ctxKey, useEcs } from "@/stores/ecs";
import { useCurrentRegion, useProfiles } from "@/stores/profiles";
import { applyPendingLink, useLinks } from "@/stores/links";
import { useTabs } from "@/stores/tabs";
import { useUpdate } from "@/stores/update";

/** Session states change as tokens expire; re-read them (local files only) this often. */
const STATUS_REFRESH_MS = 60_000;

export default function App() {
  const [info, setInfo] = useState<AppInfo>();
  useAppearance();
  const load = useProfiles((s) => s.load);
  const refreshStatuses = useProfiles((s) => s.refreshStatuses);
  const selected = useProfiles((s) => s.selected);
  const connected = useProfiles((s) => s.identity.state === "ok");
  const region = useCurrentRegion();
  const showTree = useEcs((s) => s.ctx !== null);
  const selectedService = useEcs((s) => s.selected);
  // A route map opens from a cluster, without a service.
  const hasTabs = useTabs((s) => s.tabs.length > 0);
  const ctxId = useEcs((s) => (s.ctx ? ctxKey(s.ctx) : null));
  const profilesLoaded = useProfiles((s) => s.profiles.length > 0);
  const pendingLink = useLinks((s) => s.pending);

  useEffect(() => {
    void commands.appInfo().then(setInfo);
    void load();
    void useUpdate.getState().checkOnStart();
    const timer = setInterval(() => void refreshStatuses(), STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, refreshStatuses]);

  // Browse the selected profile + region once its credentials are confirmed.
  useEffect(() => {
    if (selected && connected) {
      void useEcs.getState().activate({ profile: selected, region });
    } else if (useEcs.getState().ctx?.profile !== selected) {
      useEcs.getState().reset();
    }
  }, [selected, connected, region]);

  // Tabs belong to one profile + region: switching closes them (and their live tails).
  useEffect(() => useTabs.getState().closeAll(), [ctxId]);
  // `contrail://` links: the one Contrail was started with, and those opened while it runs. Read
  // once the profiles are known (a link names its profile).
  useEffect(() => {
    if (!profilesLoaded) return;
    const open = (urls: string[] | null) => {
      const url = urls?.[0];
      if (url) void useLinks.getState().open(url);
    };
    void getCurrent().then(open);
    const unlisten = onOpenUrl(open);
    // Stopping can fail when the app is going away anyway (the window closes; tests clear the
    // mocked IPC first): nothing is left to clean up then.
    return () => void unlisten.then((stop) => stop()).catch(() => undefined);
  }, [profilesLoaded]);
  // A link waiting for its profile and region: shown once they are the ones browsed (declared
  // after closing the tabs above, so its tab isn't closed right away).
  useEffect(() => {
    if (pendingLink && ctxId) void applyPendingLink();
  }, [pendingLink, ctxId]);

  // The selected service is shown in its tab (opened if needed).
  useEffect(() => {
    if (selectedService) useTabs.getState().activate(selectedService);
  }, [selectedService]);

  return (
    <div className="flex h-full flex-col">
      <ProfileBar demo={info?.demo ?? false} version={info?.version} />
      <LoginOutput />
      <LinkNotice />
      <div className="flex min-h-0 flex-1">
        {showTree && <Sidebar />}
        {selectedService || hasTabs ? <ServiceView /> : <ConnectionPanel />}
      </div>
      <ServicePalette />
    </div>
  );
}
