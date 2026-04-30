import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import Embed from "./Embed.tsx";

const isEmbed =
  window.location.pathname.startsWith("/embed") ||
  new URLSearchParams(window.location.search).has("embed");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isEmbed ? <Embed /> : <App />}</StrictMode>,
);
