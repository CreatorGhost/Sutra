import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import "./styles.css";
import { applyTheme } from "./app/theme";
import { desktop } from "./desktop/bridge";

// Theme before first paint (no flash).
applyTheme();
if (desktop?.platform === "darwin") document.documentElement.classList.add("mac-desktop");
else if (desktop) document.documentElement.classList.add("win-desktop");

const view = new URLSearchParams(window.location.search).get("view");
const root = ReactDOM.createRoot(document.getElementById("root")!);

async function bootstrap() {
  // The always-on-top pill is its own tiny window: no router, no database.
  if (view === "pill") {
    document.documentElement.classList.add("pill-root");
    const { Pill } = await import("./app/Pill");
    root.render(<React.StrictMode><Pill /></React.StrictMode>);
    return;
  }

  // Web dev/validation: @capacitor-community/sqlite needs the jeep-sqlite element (native uses real
  // SQLite; the desktop app uses the main-process DB and never touches this).
  if (!desktop && Capacitor.getPlatform() === "web") {
    const { defineCustomElements } = await import("jeep-sqlite/loader");
    defineCustomElements(window);
    document.body.appendChild(document.createElement("jeep-sqlite"));
    await customElements.whenDefined("jeep-sqlite");
  }
  if (Capacitor.isNativePlatform()) {
    try {
      const { StatusBar, Style } = await import("@capacitor/status-bar");
      const light = document.documentElement.getAttribute("data-theme") === "light";
      await StatusBar.setStyle({ style: light ? Style.Light : Style.Dark });
    } catch { /* plugin unavailable */ }
  }

  const { default: App } = await import("./app/App");
  // The packaged desktop app loads from file://, where path-based routing breaks — use hash routing there.
  const Router = window.location.protocol === "file:" ? HashRouter : BrowserRouter;
  root.render(
    <React.StrictMode>
      <Router>
        <App />
      </Router>
    </React.StrictMode>,
  );
}

void bootstrap();
