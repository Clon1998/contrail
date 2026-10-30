import { useState } from "react";
import { CircleStopIcon, Loader2Icon } from "lucide-react";
import { commands, type ApiError, type Task } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { shortTaskId } from "@/lib/ecs";
import { useEcs } from "@/stores/ecs";

/**
 * Confirms stopping tasks: which ones, why (ECS records the reason, as the console asks for
 * one), and what happens next. Shown only while changes to AWS are allowed.
 */
export function StopTasksDialog({
  tasks,
  open,
  onOpenChange,
  onStopped,
}: {
  tasks: Task[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStopped: () => void;
}) {
  const ctx = useEcs((s) => s.ctx);
  const selected = useEcs((s) => s.selected);
  const refresh = useEcs((s) => s.refreshService);
  const [reason, setReason] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const count = tasks.length === 1 ? "1 task" : `${tasks.length} tasks`;

  const stop = async () => {
    if (!ctx || !selected) return;
    setRunning(true);
    setError(null);
    const result = await commands.stopTasks(
      ctx,
      selected.clusterArn,
      tasks.map((t) => t.id),
      reason,
    );
    setRunning(false);
    if (result.status === "error") {
      setError(result.error);
      return;
    }
    onStopped();
    onOpenChange(false);
    setReason("");
    void refresh();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Stop {count}?</DialogTitle>
          <DialogDescription>
            ECS stops {tasks.length === 1 ? "it" : "them"} now. The service starts replacements to
            keep its desired count.
          </DialogDescription>
        </DialogHeader>
        <ul aria-label="Tasks to stop" className="space-y-1 font-mono text-xs">
          {tasks.map((t) => (
            <li key={t.id} className="flex gap-3">
              <span>{shortTaskId(t.id)}</span>
              <span className="text-muted-foreground">{t.lastStatus}</span>
              <span className="text-muted-foreground">{t.taskDefinition}</span>
            </li>
          ))}
        </ul>
        <label className="space-y-1.5 text-sm">
          <span className="text-muted-foreground">Reason (recorded by ECS)</span>
          <Input
            value={reason}
            maxLength={255}
            placeholder="Stopped in Contrail"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
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
          <Button variant="destructive" disabled={running} onClick={() => void stop()}>
            {running ? <Loader2Icon className="animate-spin" /> : <CircleStopIcon />}
            Stop {count}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
