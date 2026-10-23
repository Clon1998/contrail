import { RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { ShortcutsDialog } from "@/components/settings/ShortcutsDialog";
import { UpdateDialog } from "@/components/settings/UpdateDialog";
import { Button } from "@/components/ui/button";
import { useProfiles } from "@/stores/profiles";
import { IdentityLabel } from "./IdentityLabel";
import { LoginButton } from "./LoginButton";
import { ProfileSwitcher } from "./ProfileSwitcher";
import { RegionSelect } from "./RegionSelect";

/** The top bar: profile, region, session and identity at a glance. */
export function ProfileBar({ demo, version }: { demo: boolean; version?: string }) {
  const load = useProfiles((s) => s.load);
  const loading = useProfiles((s) => s.loading);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <span className="mr-2 text-sm font-semibold tracking-tight">Contrail</span>
      <ProfileSwitcher />
      <RegionSelect />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Reload profiles"
        tooltip="Reload profiles and sessions"
        onClick={() => void load()}
        disabled={loading}
      >
        <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
      </Button>
      <LoginButton />
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <IdentityLabel />
        {demo && <Badge variant="secondary">Demo</Badge>}
        <UpdateDialog />
        <ShortcutsDialog />
        <SettingsDialog version={version} demo={demo} />
      </div>
    </header>
  );
}
