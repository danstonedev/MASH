import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";

// Zero-UI utilities exposed to DevTools
import "./analysis/GapFill";

// Global handler for unhandled promise rejections — prevents silent failures in production
window.addEventListener("unhandledrejection", (event) => {
  console.error(
    "[MASH] Unhandled promise rejection:",
    event.reason instanceof Error ? event.reason.message : event.reason,
    event.reason instanceof Error ? event.reason.stack : "",
  );
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
