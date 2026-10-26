import { useState } from "react";
import { ExternalLinkIcon, Share2Icon } from "lucide-react";
import { commands, type ViewLink } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sameService, useEcs } from "@/stores/ecs";
import { consoleFilter, regionOf } from "@/lib/links";
import { useLogs } from "@/stores/logs";

/**
 * Share the view: a `contrail://` link to the same service, task, time window and search, or the
 * same logs in the CloudWatch console for teammates without Contrail.
 */
export function ShareMenu() {
  const view = useLogs((s) => s.view);
  const service = useLogs((s) => s.service);
  const profile = useLogs((s) => s.profile);
  const timeWindow = useLogs((s) => s.timeWindow);
  const search = useLogs((s) => s.search);
  const taskFilter = useLogs((s) => s.taskFilter);
  const region = useEcs((s) => s.ctx?.region ?? null);
  const [status, setStatus] = useState<string | null>(null);
  if (!view || !service || !profile) return null;
  const taskId = taskFilter && sameService(taskFilter.service, service) ? taskFilter.taskId : null;

  const tell = (text: string) => {
    setStatus(text);
    setTimeout(() => setStatus(null), 4_000);
  };
  const copyLink = async () => {
    const link: ViewLink = {
      profile,
      region,
      clusterArn: service.clusterArn,
      serviceName: service.serviceName,
      taskId,
      window: timeWindow,
      search: search.query.trim()
        ? { query: search.query, mode: search.mode, regex: search.regex, raw: search.raw }
        : null,
    };
    await navigator.clipboard.writeText(await commands.viewLink(link));
    tell("Link copied");
  };
  const consoleLink = () =>
    commands.consoleLink(
      view.viewId,
      regionOf(service.clusterArn),
      null,
      consoleFilter(search.query, search.regex),
    );
  const copyConsole = async () => {
    const result = await consoleLink();
    if (result.status === "ok") {
      await navigator.clipboard.writeText(result.data);
      tell("Console link copied");
    } else tell(result.error.message);
  };
  const openConsole = async () => {
    const result = await consoleLink();
    const opened = result.status === "ok" ? await commands.openConsole(result.data) : result;
    if (opened.status === "error") tell(opened.error.message);
  };

  return (
    <>
      {status && (
        <span role="status" className="text-muted-foreground">
          {status}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Share" tooltip="Share this view">
            <Share2Icon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void copyLink()}>
            Copy link (opens in Contrail)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void copyConsole()}>
            Copy CloudWatch console link
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void openConsole()}>
            <ExternalLinkIcon /> Open in CloudWatch console
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
