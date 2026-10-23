import { useState } from "react";
import { EyeIcon, KeyRoundIcon } from "lucide-react";
import type { ContainerDefinitionInfo } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { looksSecret } from "@/lib/ecs";

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
    <section aria-label="Environment">
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Environment
        </h2>
        <Input
          type="search"
          aria-label="Filter variables"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="ml-auto h-6 w-48 text-xs"
        />
      </div>
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
                    <KeyRoundIcon className="mr-1 inline size-3" />
                    from <span className="font-mono">{s.valueFrom}</span>
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
    </section>
  );
}

/** A value, masked when the name looks like a credential (shown after a click). */
function Value({ name, value }: { name: string; value: string }) {
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
