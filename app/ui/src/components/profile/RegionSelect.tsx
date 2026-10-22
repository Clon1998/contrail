import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AWS_REGIONS } from "@/lib/regions";
import { usePrefs } from "@/stores/prefs";
import { useProfiles } from "@/stores/profiles";

/** Radix Select can't use "" as a value, so "use the profile's region" gets a sentinel. */
const PROFILE_DEFAULT = "__profile__";

/** Region override for the selected profile; defaults to the profile's own region. */
export function RegionSelect() {
  const selected = useProfiles((s) => s.selected);
  const profile = useProfiles((s) => s.profiles.find((p) => p.name === s.selected));
  const override = usePrefs((s) => (selected ? s.prefs.regionOverrides[selected] : undefined));
  const setRegion = useProfiles((s) => s.setRegion);

  if (!selected) return null;
  const profileRegion = profile?.region ?? null;
  const regions = [...new Set([...(profileRegion ? [profileRegion] : []), ...AWS_REGIONS])];

  return (
    <Select
      value={override ?? PROFILE_DEFAULT}
      onValueChange={(value) => void setRegion(value === PROFILE_DEFAULT ? null : value)}
    >
      <SelectTrigger size="sm" aria-label="Region" className="w-52 font-mono text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={PROFILE_DEFAULT} className="font-mono text-xs">
          {profileRegion ?? "SDK default"}
          <span className="text-muted-foreground">(profile)</span>
        </SelectItem>
        {regions.map((region) => (
          <SelectItem key={region} value={region} className="font-mono text-xs">
            {region}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
