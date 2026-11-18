import type { AwsCtx, ServiceKey } from "@/bindings";
import { useEcs } from "@/stores/ecs";
import { currentRegion, useProfiles } from "@/stores/profiles";

/**
 * Makes `ctx` the browsed profile + region (selecting the profile and setting its region
 * override as needed) and loads its clusters (unless they are loaded already).
 */
export async function switchContext(ctx: AwsCtx): Promise<void> {
  const profiles = useProfiles.getState();
  if (profiles.selected !== ctx.profile) {
    await profiles.select(ctx.profile);
  }
  if (currentRegion() !== ctx.region) {
    const own = useProfiles.getState().profiles.find((p) => p.name === ctx.profile)?.region;
    await useProfiles.getState().setRegion(own === ctx.region ? null : ctx.region);
  }
  await useEcs.getState().activate({ profile: ctx.profile, region: currentRegion() });
}

/**
 * Opens a remembered service (favorite or recent): switches to its profile and region first if
 * needed, so it also works across profiles.
 */
export async function openServiceKey(key: ServiceKey): Promise<void> {
  await switchContext({ profile: key.profile, region: key.region });
  await useEcs.getState().openService({ clusterArn: key.clusterArn, serviceName: key.serviceName });
}
