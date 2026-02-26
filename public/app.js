import { initUI } from "./ui.js";
import { setState, State } from "./state.js";

if (!("serviceWorker" in navigator)) {
  throw new Error("Invariant violated: Service Worker unsupported");
}

navigator.serviceWorker.register("/sw.js")
  .catch(() => {
    throw new Error("Service Worker failed");
  });

document.addEventListener("DOMContentLoaded", () => {
  initUI();
  setState(State.IDLE);
});