import { StrictMode } from "react";
import { initTheme } from "./ui/shell/theme";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./index.css";

initTheme();
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
