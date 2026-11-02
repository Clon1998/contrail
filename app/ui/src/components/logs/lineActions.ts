import {
  CopyIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  FileSearchIcon,
  RouteIcon,
  UnfoldVerticalIcon,
  type LucideIcon,
} from "lucide-react";
import { commands, type LogEvent } from "@/bindings";
import { prettyJson } from "@/lib/logs";
import { regionOf } from "@/lib/links";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";
import { useTabs } from "@/stores/tabs";
import { columnValue } from "./columns";

/** Something to do with one log line: a button in its details, an item in its context menu. */
export type LineAction = {
  label: string;
  icon: LucideIcon;
  /** Explains the action (the button's tooltip). */
  hint?: string;
  run: () => void;
  /** For copy actions: the text copied (the button shows "Copied" for a moment). */
  copy?: string;
};

/**
 * The actions for a line of a service's log view, so its details and its context menu offer the
 * same. `actions` are about the line; `documentActions` about the pipeline document a status
 * change line reports (shown with its status in the details). `onSurrounding` opens the lines
 * around it; without it (already among them), that action is left out.
 */
export function useLineActions(
  event: LogEvent,
  onSurrounding?: () => void,
): { actions: LineAction[]; documentActions: LineAction[] } {
  const { line } = event;
  const setSearch = useLogs((s) => s.setSearch);
  const applySearch = useLogs((s) => s.applySearch);
  const service = useLogs((s) => s.service);
  const profile = useLogs((s) => s.profile);
  const view = useLogs((s) => s.view);
  const addNoise = usePrefs((s) => s.addNoise);
  // The first line of the message, cut at 80 characters: specific enough, short enough to read.
  const noiseText = (line.message.split("\n", 1)[0] ?? "").trim().slice(0, 80);
  const rawPretty = line.kind === "ecs" || line.kind === "json" ? prettyJson(event.raw) : null;
  // A correlation or trace ID (e.g. an API's `traceId`) can be followed across services.
  const traceId = columnValue(event, "correlation");
  const documentId = event.status?.correlationId;

  const copy = (label: string, text: string): LineAction => ({
    label,
    icon: CopyIcon,
    copy: text,
    run: () => void navigator.clipboard.writeText(text),
  });
  const trace = (id: string, term: string): LineAction | false =>
    service !== null && {
      label: "Trace across services",
      icon: RouteIcon,
      hint: "Find this ID in other services of the cluster and show the way it took (opens a tab)",
      run: () =>
        useTabs.getState().openTrace({
          id,
          term,
          at: event.timestamp,
          clusterArn: service.clusterArn,
          origin: service.serviceName,
        }),
    };

  const actions = [
    copy("Copy message", line.message),
    rawPretty && copy("Copy JSON", rawPretty),
    copy("Copy as single line", event.raw.replace(/\s*\n\s*/g, " ")),
    view &&
      onSurrounding && {
        label: "Surrounding lines",
        icon: UnfoldVerticalIcon,
        hint: "The lines of the same task before and after this one, without the search",
        run: onSurrounding,
      },
    profile &&
      service &&
      noiseText && {
        label: "Hide lines like this",
        icon: EyeOffIcon,
        hint: `Hide lines containing “${noiseText}” in this service`,
        run: () => void addNoise(profile, service, noiseText).then(applySearch),
      },
    !documentId && traceId && trace(traceId, `"${traceId}"`),
    view &&
      service && {
        label: "CloudWatch console",
        icon: ExternalLinkIcon,
        hint: "This line and a minute around it in its stream, in the AWS console",
        run: () =>
          void commands
            .consoleLink(view.viewId, regionOf(service.clusterArn), event.seq, null)
            .then((r) => (r.status === "ok" ? commands.openConsole(r.data) : r)),
      },
  ];
  const documentActions = documentId
    ? [
        {
          label: "Show this document",
          icon: FileSearchIcon,
          hint: "List every event of this document (its correlation ID) in this service",
          run: () => void setSearch({ query: `correlation:${documentId}`, mode: "filter" }),
        },
        trace(documentId, `correlation:${documentId}`),
      ]
    : [];
  const present = (a: LineAction | false | null | undefined | ""): a is LineAction => !!a;
  return { actions: actions.filter(present), documentActions: documentActions.filter(present) };
}
