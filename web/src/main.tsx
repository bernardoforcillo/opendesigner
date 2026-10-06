import { StrictMode } from "react";
import { initTheme } from "./ui/shell/theme";
import { createRoot } from "react-dom/client";
import { Root } from "./home/Root";
import "./index.css";

initTheme();
// The root chooses between Home and the editor from the URL path (home/Root.tsx).
createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
