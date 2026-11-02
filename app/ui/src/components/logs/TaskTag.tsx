import { cn } from "cn";
import { shortTaskId, toneAssigner } from "@/lib/ecs";
import { useEcs } from "@/stores/ecs";

/** Tag colours for tasks, light and dark (literal classes, so Tailwind finds them). */
const TONES = [
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
  "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-lime-500/15 text-lime-700 dark:text-lime-300",
];

/** One assigner for the whole app: a task has the same colour in every view and the picker. */
const toneOf = toneAssigner(TONES.length);

/**
 * A task's short ID. Coloured per task while the service has more than one, so the lines of
 * different tasks are told apart at a glance.
 */
export function TaskTag({ taskId, className }: { taskId: string; className?: string }) {
  const several = useEcs((s) => "data" in s.tasks && (s.tasks.data?.length ?? 0) > 1);
  return (
    <span
      className={cn(
        "rounded px-1",
        several ? TONES[toneOf(taskId)] : "bg-muted text-muted-foreground",
        className,
      )}
      title={taskId}
    >
      {shortTaskId(taskId)}
    </span>
  );
}
