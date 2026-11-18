import { installModalAccessibility } from "./modal-accessibility";
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRoot } from "./BrowserRoot";
import { ErrorBoundary } from "./ErrorBoundary";
import "./tokens.css";
import "./styles.css";
import "./panels.css";
import "./appearance";

if (window.workspace?.windowChrome)
  document.documentElement.dataset.chrome = window.workspace.windowChrome;

installModalAccessibility();
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <BrowserRoot />
  </ErrorBoundary>,
);
