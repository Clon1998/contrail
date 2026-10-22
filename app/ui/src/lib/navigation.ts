import type { ServiceKey } from "@/bindings";
import { useEcs } from "@/stores/ecs";
import { currentRegion, useProfiles } from "@/stores/profiles";

/**
 * Opens a remembered service (favorite or recent): switches to its profile and region first if
 * needed, so it also works across profiles.
 */
export async function openServiceKey(key: ServiceKey): Promise<void> {
  const profiles = useProfiles.getState();
  if (profiles.selected !== key.profile) {
    await profiles.select(key.profile);
  }
  if (currentRegion() !== key.region) {
    const own = useProfiles.getState().profiles.find((p) => p.name === key.profile)?.region;
    await useProfiles.getState().setRegion(own === key.region ? null : key.region);
  }
  const ctx = { profile: key.profile, region: currentRegion() };
  await useEcs.getState().activate(ctx);
  await useEcs.getState().openService({ clusterArn: key.clusterArn, serviceName: key.serviceName });
}
