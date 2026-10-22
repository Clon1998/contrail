import { useEffect, useState } from "react";
import { commands, type AppInfo } from "@/bindings";
import { Sidebar } from "@/components/ecs/Sidebar";
import { ConnectionPanel } from "@/components/profile/ConnectionPanel";
import { LoginOutput } from "@/components/profile/LoginOutput";
import { ProfileBar } from "@/components/profile/ProfileBar";
import { useEcs } from "@/stores/ecs";
import { useCurrentRegion, useProfiles } from "@/stores/profiles";

/** Session states change as tokens expire; re-read them (local files only) this often. */
const STATUS_REFRESH_MS = 60_000;

export default function App() {
  const [info, setInfo] = useState<AppInfo>();
  const load = useProfiles((s) => s.load);
  const refreshStatuses = useProfiles((s) => s.refreshStatuses);
  const selected = useProfiles((s) => s.selected);
  const connected = useProfiles((s) => s.identity.state === "ok");
  const region = useCurrentRegion();
  const showTree = useEcs((s) => s.ctx !== null);

  useEffect(() => {
    void commands.appInfo().then(setInfo);
    void load();
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

  return (
    <div className="flex h-full flex-col">
      <ProfileBar demo={info?.demo ?? false} />
      <LoginOutput />
      <div className="flex min-h-0 flex-1">
        {showTree && <Sidebar />}
        <ConnectionPanel />
      </div>
    </div>
  );
}
