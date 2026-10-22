import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/workspace.css";
import "./styles/connected.css";
import "./styles/system.css";
import "./styles/motion.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
