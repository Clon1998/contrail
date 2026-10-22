import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { commands, type AppInfo } from "@/bindings";

export default function App() {
  const [info, setInfo] = useState<AppInfo>();

  useEffect(() => {
    void commands.appInfo().then(setInfo);
  }, []);

  return (
    <main className="flex h-full flex-col items-center justify-center gap-2">
      <h1 className="text-3xl font-semibold tracking-tight">Contrail</h1>
      <p className="text-muted-foreground">Live logs for AWS ECS services.</p>
      {info && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          v{info.version}
          {info.demo && <Badge variant="secondary">Demo mode</Badge>}
        </p>
      )}
    </main>
  );
}
