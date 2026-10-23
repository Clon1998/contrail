import { useEffect, useState } from "react";
import { KeyboardIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** "⌘" on macOS, "Ctrl" elsewhere. */
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "General",
    keys: [
      [[MOD, "K"], "Go to a service"],
      [[MOD, "Shift", "P"], "Switch AWS profile"],
      [[MOD, ","], "Settings"],
      [["?"], "This overview"],
    ],
  },
  {
    title: "Tabs",
    keys: [
      [[MOD, "1…8"], "Show tab 1 to 8"],
      [[MOD, "9"], "Show the last tab"],
      [["Ctrl", "Tab"], "Next tab (Shift: previous)"],
      [["Middle click"], "Close a tab"],
    ],
  },
  {
    title: "Search",
    keys: [
      [[MOD, "F"], "Focus the search"],
      [["Enter"], "Next match (Shift: previous)"],
      [["F3"], "Next match (Shift: previous)"],
      [["Esc"], "Clear the search"],
    ],
  },
];

/** Whether a key press happens while typing (where "?" is just a character). */
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** The keyboard shortcuts, opened with "?" or the keyboard button. */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "?" && !event.metaKey && !event.ctrlKey && !typing(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          <KeyboardIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            The search syntax is behind the ? next to the search box.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {GROUPS.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.title}
              </h3>
              <dl className="grid grid-cols-[1fr_auto] gap-y-1">
                {group.keys.map(([keys, action]) => (
                  <div key={action + keys.join()} className="contents">
                    <dt>{action}</dt>
                    <dd className="flex gap-1">
                      {keys.map((key) => (
                        <kbd
                          key={key}
                          className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs"
                        >
                          {key}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
