import { useState } from "react";
import { EyeIcon, EyeOffIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";
import { commands, type ApiError, type ContainerDefinitionInfo } from "@/bindings";
import { CopyButton } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { looksSecret } from "@/lib/ecs";
import { OverviewCard } from "./OverviewCard";
import { useEcs } from "@/stores/ecs";

/**
 * The environment of the task definition's containers: plain variables (secret-looking values
 * masked until clicked), variables from Secrets Manager / SSM (only their reference) and env files.
 */
export function Environment({ containers }: { containers: ContainerDefinitionInfo[] }) {
  const [filter, setFilter] = useState("");
  const total = containers.reduce(
    (n, c) => n + c.environment.length + c.secrets.length + c.environmentFiles.length,
    0,
  );
  if (total === 0) return null;
  const query = filter.trim().toLowerCase();
  const matches = (...texts: string[]) =>
    query === "" || texts.some((t) => t.toLowerCase().includes(query));

  return (
    <OverviewCard
      title="Environment"
      count={total}
      action={
        <Input
          type="search"
          aria-label="Filter variables"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-7 w-48 text-xs"
        />
      }
    >
      {containers.map((container) => (
        <table key={container.name} className="mb-3 w-full table-fixed text-sm">
          {containers.length > 1 && (
            <caption className="text-left text-xs text-muted-foreground">{container.name}</caption>
          )}
          <tbody>
            {container.environment
              .filter((v) => matches(v.name, v.value))
              .map((v) => (
                <tr key={v.name} aria-label={v.name} className="border-b border-border/50">
                  <td className="w-2/5 truncate px-2 py-0.5 font-mono text-xs" title={v.name}>
                    {v.name}
                  </td>
                  <td className="px-2 py-0.5 font-mono text-xs break-all">
                    <Value name={v.name} value={v.value} />
                  </td>
                </tr>
              ))}
            {container.secrets
              .filter((s) => matches(s.name, s.valueFrom))
              .map((s) => (
                <tr key={s.name} aria-label={s.name} className="border-b border-border/50">
                  <td className="truncate px-2 py-0.5 font-mono text-xs" title={s.name}>
                    {s.name}
                  </td>
                  <td className="px-2 py-0.5 text-xs break-all text-muted-foreground">
                    <SecretValue valueFrom={s.valueFrom} />
                  </td>
                </tr>
              ))}
            {container.environmentFiles
              .filter((f) => matches(f))
              .map((f) => (
                <tr key={f} aria-label={`env file ${f}`} className="border-b border-border/50">
                  <td className="px-2 py-0.5 text-xs text-muted-foreground">env file</td>
                  <td className="px-2 py-0.5 font-mono text-xs break-all">{f}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ))}
    </OverviewCard>
  );
}

/**
 * A secret's reference, and its value once the user asks for it. The value is read from AWS on
 * that click only (each read shows up in CloudTrail), kept in this component's state and gone when
 * it is hidden or the view closes; it is never stored.
 */
export function SecretValue({ valueFrom }: { valueFrom: string }) {
  const ctx = useEcs((s) => s.ctx);
  const [state, setState] = useState<
    | { kind: "hidden" }
    | { kind: "loading" }
    | { kind: "shown"; value: string }
    | { kind: "error"; error: ApiError }
  >({ kind: "hidden" });

  const reveal = async () => {
    if (!ctx) return;
    setState({ kind: "loading" });
    const result = await commands.revealSecret(ctx, valueFrom);
    setState(
      result.status === "ok"
        ? { kind: "shown", value: result.data }
        : { kind: "error", error: result.error },
    );
  };

  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-1">
        <KeyRoundIcon className="size-3 shrink-0" />
        <span className="min-w-0 font-mono break-all">{valueFrom}</span>
      </span>
      {state.kind === "shown" ? (
        <span className="flex items-center gap-1 font-mono text-foreground">
          <span className="min-w-0 break-all">{state.value}</span>
          <CopyButton label="Copy" text={state.value} />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Hide value"
            onClick={() => setState({ kind: "hidden" })}
          >
            <EyeOffIcon />
          </Button>
        </span>
      ) : (
        <span className="flex items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            disabled={state.kind === "loading" || !ctx}
            tooltip="Reads the value from AWS now (each read shows up in CloudTrail). It is not stored."
            onClick={() => void reveal()}
          >
            {state.kind === "loading" ? <Loader2Icon className="animate-spin" /> : <EyeIcon />}
            Reveal
          </Button>
          {state.kind === "error" && (
            <span className="text-destructive">
              {state.error.message}
              {state.error.hint && (
                <span className="block text-muted-foreground">{state.error.hint}</span>
              )}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** A value, masked when the name looks like a credential (shown after a click). */
export function Value({ name, value }: { name: string; value: string }) {
  const [shown, setShown] = useState(false);
  if (shown || !looksSecret(name) || value === "") return <>{value}</>;
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      ••••••••
      <Button variant="ghost" size="icon-xs" aria-label="Show value" onClick={() => setShown(true)}>
        <EyeIcon />
      </Button>
    </span>
  );
}
