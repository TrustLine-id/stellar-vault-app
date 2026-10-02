import { Buffer } from "buffer";
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./Shell";
import RiskNotice from "./components/RiskNotice";
import { AppProvider } from "./state";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RiskNotice>
      <AppProvider>
        <App />
      </AppProvider>
    </RiskNotice>
  </StrictMode>,
);
