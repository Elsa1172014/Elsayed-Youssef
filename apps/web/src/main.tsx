import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// TV builds opt in via VITE_TV_MODE=true; standard web deployments stay unchanged.
if (import.meta.env.VITE_TV_MODE === "true") {
  document.documentElement.classList.add("tv-mode");
  void Promise.all([
    import("../../../tv/remote-navigation.js"),
    import("../../../tv/tv.css"),
  ]).then(([navigation]) => {
    navigation.installTvRemoteNavigation();
  });
}

createRoot(document.getElementById("root")!).render(<App />);
