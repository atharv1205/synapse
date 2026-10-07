import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { usePathname } from "./router";
import "./styles/tokens.css";

// Each route is its own chunk: the landing page never downloads the explorer's panels,
// and the explorer never downloads the landing page's text.
const Landing = lazy(() => import("./landing/Landing").then((m) => ({ default: m.Landing })));
const NotFound = lazy(() => import("./landing/Landing").then((m) => ({ default: m.NotFound })));
const App = lazy(() => import("./App").then((m) => ({ default: m.App })));

function Root() {
  const pathname = usePathname().replace(/\/+$/, "") || "/";

  const page =
    pathname === "/" ? <Landing /> : pathname === "/graph" ? <App /> : <NotFound />;

  // The fallback is just the dark background, so a route loading shows nothing instead of
  // flashing some other screen.
  return <Suspense fallback={null}>{page}</Suspense>;
}

const container = document.getElementById("root");
if (!container) throw new Error("No #root element in the document");

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
