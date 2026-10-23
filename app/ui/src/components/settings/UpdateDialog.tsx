import { DownloadIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdate } from "@/stores/update";

/** Where releases are, for installing by hand. */
const RELEASES_URL = "https://github.com/Clon1998/contrail/releases/latest";

/**
 * A newer Contrail: a header button while one is known, and the dialog with its notes, "Install
 * and restart" and the download progress.
 */
export function UpdateDialog() {
  const available = useUpdate((s) => s.available);
  const phase = useUpdate((s) => s.phase);
  const progress = useUpdate((s) => s.progress);
  const error = useUpdate((s) => s.error);
  const open = useUpdate((s) => s.dialogOpen);
  const setOpen = useUpdate((s) => s.setDialogOpen);
  const install = useUpdate((s) => s.install);
  const cancel = useUpdate((s) => s.cancel);
  if (!available) return null;

  const busy = phase === "downloading" || phase === "installing";
  const share =
    progress?.total && progress.total > 0
      ? Math.min(progress.downloaded / progress.total, 1)
      : null;

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        className="border-primary/50 text-primary"
        onClick={() => setOpen(true)}
      >
        <DownloadIcon /> Update to {available.version}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Contrail {available.version} is available</DialogTitle>
            <DialogDescription>You have {available.currentVersion}.</DialogDescription>
          </DialogHeader>
          {available.notes && (
            <div className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
              {available.notes}
            </div>
          )}
          {available.installBlocker ? (
            <p className="text-sm text-muted-foreground">
              This copy can’t update itself: {available.installBlocker}. Download the new version
              from{" "}
              <a
                className="text-primary underline"
                href={RELEASES_URL}
                target="_blank"
                rel="noreferrer"
              >
                the releases page
              </a>
              .
            </p>
          ) : busy ? (
            <div className="space-y-2">
              <div
                role="progressbar"
                aria-label="Update download"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={share === null ? undefined : Math.round(share * 100)}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${(share ?? 0.1) * 100}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Loader2Icon className="size-3 animate-spin" />
                  {phase === "installing" ? "Installing, Contrail restarts…" : "Downloading…"}
                </span>
                {phase === "downloading" && (
                  <Button variant="ghost" size="xs" onClick={cancel}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Later
              </Button>
              <Button size="sm" onClick={() => void install()}>
                Install and restart
              </Button>
            </div>
          )}
          {error && (
            <p className="text-sm text-destructive">
              {error.message}
              {error.hint && <span className="block text-muted-foreground">{error.hint}</span>}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
