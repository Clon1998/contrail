import { invoke } from "@tauri-apps/api/core";

// Typed wrappers around the Rust commands in app/src-tauri/src/commands.rs.
// Components call these instead of `invoke`, so command names and argument shapes live in one place.

export function greet(name: string): Promise<string> {
  return invoke<string>("greet", { name });
}
