import { StrictMode } from "react";
import { initTheme } from "./ui/shell/theme";
import { createRoot } from "react-dom/client";
import { Root } from "./home/Root";
import "./index.css";

initTheme();
// La radice sceglie fra Home ed editor dall'hash (home/Root.tsx).
createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
