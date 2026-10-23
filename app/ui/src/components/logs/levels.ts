import type { Level } from "@/bindings";

/** Text colour per log level. */
export const LEVEL_TONE: Record<Level, string> = {
  ERROR: "text-destructive",
  WARN: "text-warning",
  INFO: "text-foreground",
  DEBUG: "text-muted-foreground",
  TRACE: "text-muted-foreground/70",
};

export const LEVELS: Level[] = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

/** The hidden levels after clicking `level`'s chip: hides or shows it. */
export function toggleLevel(hidden: Level[], level: Level): Level[] {
  return hidden.includes(level) ? hidden.filter((l) => l !== level) : [...hidden, level];
}

/** "Only this": hides every other level; if that is already the case, shows all again. */
export function hiddenForOnly(hidden: Level[], level: Level): Level[] {
  const others = LEVELS.filter((l) => l !== level);
  const alreadyOnly = !hidden.includes(level) && others.every((l) => hidden.includes(l));
  return alreadyOnly ? [] : others;
}

/** "This and above": hides the less severe levels (`LEVELS` is ordered most severe first). */
export function hiddenForAtLeast(level: Level): Level[] {
  return LEVELS.slice(LEVELS.indexOf(level) + 1);
}
