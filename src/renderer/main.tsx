import { installModalAccessibility } from "./modal-accessibility";
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRoot } from "./BrowserRoot";
import "./styles.css";
import "./appearance";

installModalAccessibility();
createRoot(document.getElementById("root")!).render(<BrowserRoot />);
