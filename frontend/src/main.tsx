import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import { defineCustomElements as jeepSqlite } from "jeep-sqlite/loader";
import App from "./App";
import "./index.css";

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
