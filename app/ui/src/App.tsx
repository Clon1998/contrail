import { useEffect, useState } from "react";
import { commands, type AppInfo } from "@/bindings";
import { ConnectionPanel } from "@/components/profile/ConnectionPanel";
import { LoginOutput } from "@/components/profile/LoginOutput";
import { ProfileBar } from "@/components/profile/ProfileBar";
import { useProfiles } from "@/stores/profiles";

/** Session states change as tokens expire; re-read them (local files only) this often. */
const STATUS_REFRESH_MS = 60_000;

export default function App() {
  const [info, setInfo] = useState<AppInfo>();
  const load = useProfiles((s) => s.load);
  const refreshStatuses = useProfiles((s) => s.refreshStatuses);

  useEffect(() => {
    void commands.appInfo().then(setInfo);
    void load();
    const timer = setInterval(() => void refreshStatuses(), STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, refreshStatuses]);

  return (
    <div className="flex h-full flex-col">
      <ProfileBar demo={info?.demo ?? false} />
      <LoginOutput />
      <ConnectionPanel />
    </div>
  );
}
