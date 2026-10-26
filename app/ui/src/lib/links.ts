/** The region of a cluster (`arn:aws:ecs:<region>:…`). */
export const regionOf = (clusterArn: string) => clusterArn.split(":")[3] ?? "";

/**
 * The text the CloudWatch console can search for: plain words only (Contrail's field terms,
 * exclusions and regular expressions mean nothing there). `null` when the search isn't that simple.
 */
export function consoleFilter(query: string, regex: boolean): string | null {
  const text = query.trim();
  return !regex && text && /^[\w .@/-]+$/.test(text) && !/(^|\s)-/.test(text) ? text : null;
}
