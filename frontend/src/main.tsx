import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import { defineCustomElements as jeepSqlite } from "jeep-sqlite/loader";
import App from "./App";
import "./index.css";
import { syncNativeChrome } from "./lib/nativeChrome";

// Apply the saved appearance choice before first paint so there's no theme flash.
// Stored value is "system" | "dark" | "light"; unset/anything else => dark (the default).
// "system" follows the OS preference via matchMedia; dark stays the default when no light pref.
function applyTheme(choice?: string | null) {
  const root = document.documentElement;
  const resolved =
    choice === "light"
      ? "light"
      : choice === "system"
        ? (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark")
        : "dark";
  if (resolved === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
}

const storedTheme = (() => {
  try { return localStorage.getItem("sutra_theme"); } catch { return null; }
})();
applyTheme(storedTheme);
void syncNativeChrome();
// When the choice is "system", keep tracking live OS changes for the session.
if (storedTheme === "system" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
    applyTheme("system");
    void syncNativeChrome();
  });
}

async function bootstrap() {
  // Web dev/validation fallback: @capacitor-community/sqlite needs the jeep-sqlite web component
  // (native Android uses real SQLite — no jeep-sqlite). The SQLCipher key path is native-only.
  if (Capacitor.getPlatform() === "web") {
    jeepSqlite(window);
    const el = document.createElement("jeep-sqlite");
    document.body.appendChild(el);
    await customElements.whenDefined("jeep-sqlite");
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
}

void bootstrap();
