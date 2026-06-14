import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Landing from "@/pages/Landing";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

// Synchronously parse query parameter on module evaluation to guarantee localStorage availability before any React mounting
if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  const emailParam = params.get("email");
  if (emailParam) {
    localStorage.setItem("tatkal_user", emailParam);
    // Strip the query parameters cleanly from the address bar to keep it neat
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={Login} />
      <Route path="/dashboard" component={Dashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

/** Listens for cross-origin postMessage from landing.html.
 *  On mount, signals 'tatkal_ready' to the parent so landing.html can
 *  deliver credentials even after a Vite hot-reload (handshake pattern).
 *  When tatkal_auth arrives, writes the email to localStorage and
 *  navigates straight to /dashboard — no second login needed. */
function AuthBridge() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    // Signal readiness to parent (landing.html) — covers the hot-reload case
    // where the URL param was already consumed and cleared from the address bar.
    if (window.parent !== window) {
      window.parent.postMessage({ type: "tatkal_ready" }, "http://localhost:8000");
    }

    const handler = (event: MessageEvent) => {
      // Accept credentials from the orchestrator landing page or the simulator landing
      const allowedOrigins = ["http://localhost:8000", "http://localhost:8001"];
      // tatkal_logout may arrive with '*' targetOrigin — accept from any trusted port
      const isLogout = event.data?.type === "tatkal_logout";
      if (!isLogout && !allowedOrigins.includes(event.origin)) return;

      if (event.data?.type === "tatkal_auth" && event.data?.email) {
        localStorage.setItem("tatkal_user", event.data.email);
        setLocation("/dashboard");
      }
      if (isLogout) {
        localStorage.removeItem("tatkal_user");
        setLocation("/");
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [setLocation]);

  return null;
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthBridge />
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
