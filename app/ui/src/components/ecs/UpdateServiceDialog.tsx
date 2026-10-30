import { useEffect, useState } from "react";
import { ArrowRightIcon, Loader2Icon, RocketIcon } from "lucide-react";
import { commands, type ApiError, type ServiceDetail, type ServiceUpdate } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { currentTaskDefinition } from "@/lib/ecs";
import { useEcs } from "@/stores/ecs";

/**
 * The console's quick update: desired count, task definition revision and a new deployment in
 * one dialog. The changes are listed above the button, so the click confirms exactly those.
 * Shown only while changes to AWS are allowed; mounted while open, so it starts afresh.
 */
export function UpdateServiceDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: ServiceDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ctx = useEcs((s) => s.ctx);
  const selected = useEcs((s) => s.selected);
  const refresh = useEcs((s) => s.refreshService);
  const current = currentTaskDefinition(detail);
  const family = detail.taskDefinition?.family ?? current.replace(/:\d+$/, "");
  const [desired, setDesired] = useState(String(detail.summary.desired));
  const [revision, setRevision] = useState(current);
  const [force, setForce] = useState(false);
  const [revisions, setRevisions] = useState<string[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // The family's revisions, newest first, when the dialog opens.
  useEffect(() => {
    if (!open || !ctx) return;
    let alive = true;
    void commands.taskDefinitionRevisions(ctx, family).then((result) => {
      if (!alive) return;
      if (result.status === "ok") setRevisions(result.data);
      else setError(result.error);
    });
    return () => {
      alive = false;
    };
  }, [open, ctx, family]);

  const count = Number(desired);
  const validCount = desired.trim() !== "" && Number.isInteger(count) && count >= 0;
  const update: ServiceUpdate = {
    desiredCount: validCount && count !== detail.summary.desired ? count : null,
    taskDefinition: revision !== current ? revision : null,
    forceNewDeployment: force,
  };
  const changes = [
    update.desiredCount !== null && {
      label: "Desired count",
      from: String(detail.summary.desired),
      to: String(update.desiredCount),
    },
    update.taskDefinition !== null && {
      label: "Task definition",
      from: current,
      to: update.taskDefinition,
    },
    force && { label: "New deployment", from: null, to: "replace every task" },
  ].filter((c) => c !== false);

  const apply = async () => {
    if (!ctx || !selected) return;
    setRunning(true);
    setError(null);
    const result = await commands.updateService(ctx, selected, update);
    setRunning(false);
    if (result.status === "error") {
      setError(result.error);
      return;
    }
    onOpenChange(false);
    void refresh();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Update {detail.summary.name}</DialogTitle>
          <DialogDescription>
            Like the console's quick update. A new revision or a new deployment replaces the tasks
            with a rolling deployment.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-sm">
          <label htmlFor="desired-count" className="text-muted-foreground">
            Desired count
          </label>
          <Input
            id="desired-count"
            type="number"
            min={0}
            value={desired}
            aria-invalid={!validCount}
            onChange={(e) => setDesired(e.target.value)}
            className="h-8 w-28"
          />
          <span className="text-muted-foreground">Task definition</span>
          <Select value={revision} onValueChange={setRevision}>
            <SelectTrigger size="sm" aria-label="Task definition revision" className="font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* The current one even before the list is there (or if it isn't in it). */}
              {!(revisions ?? []).includes(current) && (
                <SelectItem value={current} className="font-mono">
                  {current} (current)
                </SelectItem>
              )}
              {(revisions ?? []).map((r) => (
                <SelectItem key={r} value={r} className="font-mono">
                  {r}
                  {r === current && " (current)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span />
          <label className="flex items-center gap-2">
            <Checkbox checked={force} onCheckedChange={(on) => setForce(on === true)} />
            Force new deployment
          </label>
        </div>

        <section aria-label="Changes" className="rounded-md border border-border bg-muted/30 p-3">
          {changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing changes yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {changes.map((c) => (
                <li key={c.label} className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">{c.label}</span>
                  {c.from !== null && (
                    <>
                      <span className="font-mono">{c.from}</span>
                      <ArrowRightIcon className="size-3.5 text-muted-foreground" />
                    </>
                  )}
                  <span className="font-mono font-medium">{c.to}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        {error && (
          <p className="text-sm text-destructive">
            {error.message}
            {error.hint && <span className="block text-muted-foreground">{error.hint}</span>}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={running} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={running || changes.length === 0 || !validCount}
            onClick={() => void apply()}
          >
            {running ? <Loader2Icon className="animate-spin" /> : <RocketIcon />}
            Update service
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
