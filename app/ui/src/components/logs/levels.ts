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
