import { useEffect, useState } from "react";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { accountId } from "@/lib/session";
import { useProfiles } from "@/stores/profiles";
import { SessionBadge, SessionDot } from "./SessionBadge";

/** Search-as-you-type profile picker. Opens with ⌘⇧P / Ctrl+Shift+P. */
export function ProfileSwitcher() {
  const profiles = useProfiles((s) => s.profiles);
  const statuses = useProfiles((s) => s.statuses);
  const selected = useProfiles((s) => s.selected);
  const select = useProfiles((s) => s.select);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const current = profiles.find((p) => p.name === selected);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="AWS profile"
          className="min-w-56 justify-between font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            {current ? (
              <>
                <SessionDot status={statuses[current.name]} />
                <span className="truncate font-medium">{current.name}</span>
                {accountId(current) && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {accountId(current)}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">Select profile…</span>
            )}
          </span>
          <ChevronsUpDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search profiles or account IDs…" />
          <CommandList>
            <CommandEmpty>No profile found.</CommandEmpty>
            <CommandGroup>
              {profiles.map((profile) => (
                <CommandItem
                  key={profile.name}
                  // cmdk filters on `value` + `keywords`: name, account ID and region.
                  value={profile.name}
                  keywords={[accountId(profile) ?? "", profile.region ?? ""]}
                  onSelect={() => {
                    setOpen(false);
                    void select(profile.name);
                  }}
                >
                  <CheckIcon className={profile.name === selected ? "opacity-100" : "opacity-0"} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{profile.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {[accountId(profile), profile.region].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </div>
                  {profile.auth.kind === "misconfigured" ? (
                    <span className="text-xs text-destructive">misconfigured</span>
                  ) : (
                    <SessionBadge status={statuses[profile.name]} />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
