import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// UI flow tests (Playwright) run the dev server with VITE_E2E=1 and a fake backend instead of
// Tauri. Vite replaces `import.meta.env.VITE_E2E` at build time, so a normal build drops this
// branch and never bundles the fake.
const ready =
  import.meta.env.VITE_E2E === "1"
    ? import("./e2e/fakeBackend").then((m) =>
        m.installFakeBackend({
          loginDelayMs: 600,
          // `?rowsDelay=30` simulates the IPC latency of row fetches (scrolling checks).
          rowsDelayMs: Number(new URLSearchParams(location.search).get("rowsDelay") ?? 0),
          olderDelayMs: Number(new URLSearchParams(location.search).get("olderDelay") ?? 0),
          update: new URLSearchParams(location.search).get("update") ?? undefined,
          // `?link=contrail://…`: a link Contrail was started with.
          link: new URLSearchParams(location.search).get("link") ?? undefined,
        }),
      )
    : Promise.resolve();

void ready.then(() =>
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
