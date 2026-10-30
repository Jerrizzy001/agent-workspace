import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRoot } from "./BrowserRoot";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<BrowserRoot />);
