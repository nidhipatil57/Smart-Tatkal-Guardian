import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { Shield, LogOut, Play, Square, Activity, Target, Database, Ban, Scale, Wifi, WifiOff, Zap, ShieldAlert, Bug, Users, TrendingUp, Bell, Clock, MapPin, ListOrdered } from "lucide-react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";
import { motion, AnimatePresence } from "framer-motion";

type RequestType = "ALLOW" | "BLOCK" | "HONEY" | "CAPTCHA";

interface LiveRequest {
  id: string;
  timestamp: string;
  type: RequestType;
  user_id: string;
  train_id: string;
  route: string;
  score: number;
  flags?: string[];
  queue_position?: number | null;
  estimated_wait?: string | null;
  priority_score?: number | null;
}

interface AlertStatus {
  alert_active: boolean;
  blocked_bots: number;
  requests_per_sec: number;
  affected_route: string;
  top_ip: string;
}

interface Analytics {
  peak_attack_hour: number | null;
  peak_attack_count: number;
  top_attacking_ips: { ip: string; count: number }[];
  top_targeted_routes: { route: string; count: number }[];
  hourly_attacks: number[];
}

interface HoneypotEntry {
  id: string;
  text: string;
  time: string;
  isConfirmed: boolean;
}

import IndiaMap, { MapDot } from "@/components/IndiaMap";

const CITY_COORDS: Record<string, [number, number]> = {
  "MUMBAI": [19.076, 72.877],
  "DELHI": [28.613, 77.209],
  "PUNE": [18.520, 73.856],
  "JAIPUR": [26.912, 75.787],
  "AHMEDABAD": [23.022, 72.571],
  "CHENNAI": [13.082, 80.270],
  "KOLKATA": [22.572, 88.363],
  "HYDERABAD": [17.385, 78.486]
};

const getCityFromRoute = (route: string): string => {
  const src = route.split("-")[0]?.toUpperCase() || "";
  if (src === "NDLS" || src === "NZM") return "DELHI";
  if (src === "BCT") return "MUMBAI";
  if (src === "SBC") return "HYDERABAD";
  if (src === "HWH") return "KOLKATA";
  if (src === "MAS") return "CHENNAI";
  return src;
};

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const [user, setUser] = useState<string | null>(null);

  const [isRunning, setIsRunning] = useState(false);
  const [rps, setRps] = useState(10);

  const [stats, setStats] = useState({ total: 0, blocked: 0, passed: 0, honey: 0, captcha: 0 });
  const [requests, setRequests] = useState<LiveRequest[]>([]);
  const [mapDots, setMapDots] = useState<MapDot[]>([]);
  const [activeTab, setActiveTab] = useState<'feed' | 'map' | 'analytics' | 'admin'>('feed');
  // topIps derived from analytics — no separate state needed
  const [blacklist, setBlacklist] = useState<{ ip: string, count: number, last_seen: string }[]>([]);
  const [honeypotLog, setHoneypotLog] = useState<HoneypotEntry[]>([]);
  const pendingHoneypotsRef = useRef<{ userId: string; countdown: number; train_id: string; route: string; timestamp: string }[]>([]);
  const [timeSeriesData, setTimeSeriesData] = useState<{ time: string; bots: number; genuine: number; rate?: number }[]>([]);
  const [heatmapData, setHeatmapData] = useState<number[]>(Array(60).fill(0));
  const heatmapRef = useRef<number[]>(Array(60).fill(0));
  const currentSecondCounts = useRef({ bots: 0, genuine: 0 });
  const [dataSource, setDataSource] = useState<'ws' | 'mock' | null>(null);
  const [isDark, setIsDark] = useState(true);
  const [alert, setAlert] = useState<AlertStatus | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [queueEntries, setQueueEntries] = useState<{ user_id: string; queue_position: number; estimated_wait: string; priority_score: number }[]>([]);

  useEffect(() => {
    const tatkalUser = localStorage.getItem("tatkal_user");
    if (!tatkalUser) {
      setLocation("/login");
    } else {
      setUser(tatkalUser);
    }
  }, [setLocation]);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Shared handler: updates all dashboard state from a single event
  const handleEvent = useCallback((data: LiveRequest) => {
    const type = data.type;

    setStats(prev => ({
      total: prev.total + 1,
      blocked: prev.blocked + (type === "BLOCK" ? 1 : 0),
      passed: prev.passed + (type === "ALLOW" ? 1 : 0),
      honey: prev.honey + (type === "HONEY" ? 1 : 0),
      captcha: (prev.captcha || 0) + (type === "CAPTCHA" ? 1 : 0)
    }));

    setRequests(prev => [data, ...prev].slice(0, 50));

    if (type === "BLOCK") {
      setBlacklist(prev => {
        const userId = data.user_id || "unknown";
        const existing = prev.find(e => e.ip === userId);
        if (existing) {
          return prev
            .map(e => e.ip === userId ? { ...e, count: e.count + 1, last_seen: data.timestamp } : e)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
        }
        return [{ ip: userId, count: 1, last_seen: data.timestamp }, ...prev]
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
      });
    }

    // Process countdowns for any pending honeypots
    const completedEntries: HoneypotEntry[] = [];
    pendingHoneypotsRef.current = pendingHoneypotsRef.current
      .map(p => {
        const nextCountdown = p.countdown - 1;
        if (nextCountdown <= 0) {
          completedEntries.push({
            id: `${p.userId}_confirmed_${Math.random().toString(36).substring(2, 9)}`,
            text: `${p.userId} → Attempted fake booking ← CONFIRMED BOT`,
            time: data.timestamp,
            isConfirmed: true
          });
        }
        return { ...p, countdown: nextCountdown };
      })
      .filter(p => p.countdown > 0);

    const newEntries: HoneypotEntry[] = [];
    if (type === "HONEY") {
      newEntries.push({
        id: `${data.user_id}_shown_${Math.random().toString(36).substring(2, 9)}`,
        text: `${data.user_id} → Shown fake slot [${data.train_id}] [${data.route}]`,
        time: data.timestamp,
        isConfirmed: false
      });

      // Track pending honeypot user: 3-5 events later
      pendingHoneypotsRef.current.push({
        userId: data.user_id,
        countdown: Math.floor(Math.random() * 3) + 3, // 3, 4, or 5 events later
        train_id: data.train_id,
        route: data.route,
        timestamp: data.timestamp
      });
    }

    // Combine completed and new entries
    const entriesToAdd = [...completedEntries, ...newEntries];
    if (entriesToAdd.length > 0) {
      setHoneypotLog(prev => [...entriesToAdd, ...prev].slice(0, 15));
    }

    if (type === "BLOCK" || type === "HONEY" || type === "CAPTCHA") {
      currentSecondCounts.current.bots += 1;
    } else {
      currentSecondCounts.current.genuine += 1;
    }

    if (type === "BLOCK" || type === "HONEY" || type === "CAPTCHA") {
      const nowSlot = Math.floor(Date.now() / 1000) % 60;
      heatmapRef.current = [...heatmapRef.current];
      heatmapRef.current[nowSlot] = (heatmapRef.current[nowSlot] || 0) + 1;
      setHeatmapData([...heatmapRef.current]);
    }

    // ── Update India Map Dots State ──
    const city = getCityFromRoute(data.route);
    const latlng = CITY_COORDS[city];
    if (latlng) {
      const isBot = type === "BLOCK" || type === "HONEY";
      const dotId = data.id || Math.random().toString(36).substring(2, 9);
      const newDot: MapDot = {
        id: dotId,
        latlng,
        city,
        isBot,
        userId: data.user_id,
        action: type,
        score: data.score,
        timestamp: new Date()
      };

      setMapDots(prev => {
        const list = [newDot, ...prev];
        return list.slice(0, 100); // Max 100 dots at once
      });

      // Dot disappears after 3 seconds (bot) or 5 seconds (human)
      setTimeout(() => {
        setMapDots(prev => prev.filter(d => d.id !== dotId));
      }, isBot ? 3000 : 5000);
    }
  }, []);

  // Generate a mock request and feed it through handleEvent
  const generateRequest = useCallback(() => {
    const isBot = Math.random() < 0.8;
    const score = isBot ? Math.floor(Math.random() * 40) + 60 : Math.floor(Math.random() * 31) + 5;

    let type: RequestType = "ALLOW";
    if (score >= 85) type = "HONEY";
    else if (score >= 70) type = "BLOCK";
    else if (score >= 50) type = "CAPTCHA";

    const userId = `USR_${Math.floor(Math.random() * 9000) + 1000}`;
    // For ALLOW events, generate realistic queue slot info
    const priorityScore = type === 'ALLOW' ? Math.max(0, 100 - score) : undefined;
    const queuePosition = type === 'ALLOW' ? Math.floor(Math.random() * 15) + 1 : undefined;
    const waitSecs = queuePosition != null ? Math.max(0, (queuePosition - 1) / 2) : undefined;
    const estimatedWait = waitSecs != null
      ? (waitSecs < 60 ? `~${Math.round(waitSecs)}s` : `~${Math.floor(waitSecs / 60)}m ${Math.round(waitSecs % 60)}s`)
      : undefined;

    const newReq: LiveRequest = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 2 }),
      type,
      user_id: userId,
      train_id: ["12903_GOLD", "12904_EXP", "22691_RAJD", "12431_TRV"][Math.floor(Math.random() * 4)],
      route: ["NDLS-BCT", "BCT-NDLS", "SBC-NZM", "HWH-MAS"][Math.floor(Math.random() * 4)],
      score,
      queue_position: queuePosition ?? null,
      priority_score: priorityScore ?? null,
      estimated_wait: estimatedWait ?? null,
    };

    handleEvent(newReq);
  }, [handleEvent]);

  // Start mock fallback interval
  const startMockInterval = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const ms = 1000 / rps;
    intervalRef.current = setInterval(generateRequest, ms);
    setDataSource('mock');
  }, [rps, generateRequest]);

  // WebSocket-first with 2-second fallback to mock data
  useEffect(() => {
    if (!isRunning) {
      // Clean up everything when stopped
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setDataSource(null);
      return;
    }

    let fallbackTimer: NodeJS.Timeout | null = null;
    let cancelled = false;

    try {
      const ws = new WebSocket('ws://localhost:8000/ws/events');
      wsRef.current = ws;

      // Start a 2-second countdown — if WS hasn't opened by then, fall back
      fallbackTimer = setTimeout(() => {
        if (!cancelled && ws.readyState !== WebSocket.OPEN) {
          console.log('[Dashboard] WebSocket timeout — falling back to mock data');
          ws.close();
          wsRef.current = null;
          startMockInterval();
        }
      }, 2000);

      ws.onopen = () => {
        if (cancelled) { ws.close(); return; }
        console.log('[Dashboard] WebSocket connected');
        if (fallbackTimer) clearTimeout(fallbackTimer);
        setDataSource('ws');
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(event.data);
          if (data && data.type === "stats") {
            setStats({
              total: data.stats.total || 0,
              blocked: data.stats.blocked || data.stats.block || 0,
              passed: data.stats.passed || data.stats.allowed || 0,
              honey: data.stats.honey || 0,
              captcha: data.stats.captcha || 0
            });
          } else {
            handleEvent(data as LiveRequest);
          }
        } catch (err) {
          console.warn('[Dashboard] Bad WS message:', err);
        }
      };

      ws.onerror = () => {
        if (cancelled) return;
        console.log('[Dashboard] WebSocket error — falling back to mock data');
        if (fallbackTimer) clearTimeout(fallbackTimer);
        ws.close();
        wsRef.current = null;
        startMockInterval();
      };

      ws.onclose = () => {
        if (cancelled) return;
        // If WS closes unexpectedly while we're still running, fall back
        if (wsRef.current === ws && !intervalRef.current) {
          console.log('[Dashboard] WebSocket closed — falling back to mock data');
          wsRef.current = null;
          startMockInterval();
        }
      };
    } catch {
      // WebSocket constructor itself failed
      console.log('[Dashboard] WebSocket unavailable — using mock data');
      startMockInterval();
    }

    return () => {
      cancelled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isRunning, rps, handleEvent, startMockInterval]);

  // Sample per-second counts into the time series
  const timeSeriesRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (isRunning) {
      currentSecondCounts.current = { bots: 0, genuine: 0 };
      timeSeriesRef.current = setInterval(() => {
        const now = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const { bots, genuine } = currentSecondCounts.current;
        currentSecondCounts.current = { bots: 0, genuine: 0 };
        const total = bots + genuine;
        const rate = total > 0 ? Math.round((bots / total) * 100) : 0;
        setTimeSeriesData(prev => [...prev, { time: now, bots, genuine, rate }].slice(-30));
      }, 1000);
    } else {
      if (timeSeriesRef.current) clearInterval(timeSeriesRef.current);
    }
    return () => {
      if (timeSeriesRef.current) clearInterval(timeSeriesRef.current);
    };
  }, [isRunning]);

  const handleToggleSimulation = async () => {
    const nextState = !isRunning;
    setIsRunning(nextState);
    try {
      if (nextState) {
        await fetch(`http://localhost:8001/simulate/start?rps=${rps}`, { method: 'POST' });
      } else {
        await fetch('http://localhost:8001/simulate/stop', { method: 'POST' });
      }
    } catch (err) {
      console.warn('Failed to control backend simulator:', err);
    }
  };

  // Auto-start simulation + sync status on mount
  useEffect(() => {
    fetch('http://localhost:8001/simulate/status')
      .then(res => res.json())
      .then(data => {
        if (data && typeof data.running === 'boolean') {
          setIsRunning(data.running);
          // Auto-start if not already running
          if (!data.running) {
            fetch(`http://localhost:8001/simulate/start?rps=${rps}`, { method: 'POST' })
              .then(() => setIsRunning(true))
              .catch(() => { });
          }
        }
      })
      .catch(() => { });
  }, []);

  // Poll /alert/status and /analytics every 3 seconds
  useEffect(() => {
    const poll = async () => {
      try {
        const [alertRes, analyticsRes, queueRes] = await Promise.all([
          fetch('http://localhost:8000/alert/status'),
          fetch('http://localhost:8000/analytics'),
          fetch('http://localhost:8000/queue/stats'),
        ]);
        if (alertRes.ok) setAlert(await alertRes.json());
        if (analyticsRes.ok) setAnalytics(await analyticsRes.json());
        if (queueRes.ok) {
          const q = await queueRes.json();
          setQueueEntries(q.entries || []);
        }
      } catch { /* orchestrator offline */ }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, []);

  // Live queue update: when an ALLOW event arrives with queue info, merge it in
  // This gives real-time queue updates between the 3-second poll intervals
  useEffect(() => {
    const lastReq = requests[0];
    if (
      lastReq?.type === 'ALLOW' &&
      lastReq.queue_position != null &&
      lastReq.priority_score != null &&
      lastReq.estimated_wait != null
    ) {
      setQueueEntries(prev => {
        const filtered = prev.filter(e => e.user_id !== lastReq.user_id);
        const newEntry = {
          user_id: lastReq.user_id,
          queue_position: lastReq.queue_position!,
          priority_score: lastReq.priority_score!,
          estimated_wait: lastReq.estimated_wait!,
        };
        return [newEntry, ...filtered]
          .sort((a, b) => a.queue_position - b.queue_position)
          .slice(0, 20);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests]);

  const handleThemeToggle = () => {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("tatkal_user");
    setLocation("/");
  };

  if (!user) return null;

  const getInitials = (email: string) => email.substring(0, 2).toUpperCase();

  // Computed helpers
  const blockRate = stats.total > 0 ? ((stats.blocked + stats.honey) / stats.total * 100).toFixed(1) : '0.0';
  const topIps: { ip: string; count: number; region: string }[] = (analytics?.top_attacking_ips ?? []).map(entry => ({ ip: entry.ip, count: entry.count, region: 'India' }));

  return (
    <div className="h-screen w-full bg-background flex flex-col font-sans overflow-hidden">
      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <header className="h-14 border-b border-border bg-card/80 backdrop-blur-md flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-blue-400 rounded-lg flex items-center justify-center shadow-[0_0_12px_rgba(59,130,246,0.35)]">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <div className="flex flex-col">
            <span className="text-[0.85rem] font-bold text-foreground tracking-tight leading-tight">Smart Tatkal Guardian</span>
            <span className="text-[0.6rem] text-muted-foreground uppercase tracking-[0.15em] leading-tight">Network Operations Center</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Data source indicator */}
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[0.65rem] font-semibold border transition-colors ${dataSource === 'ws'
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              : dataSource === 'mock'
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                : 'bg-card text-muted-foreground border-border'
            }`}>
            {dataSource === 'ws' ? <Wifi className="w-3 h-3" /> : dataSource === 'mock' ? <Zap className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {dataSource === 'ws' ? 'LIVE' : dataSource === 'mock' ? 'SIMULATED' : 'IDLE'}
          </div>
          {/* User avatar */}
          <div className="flex items-center gap-2 pl-3 border-l border-border">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-600 to-indigo-500 text-white flex items-center justify-center text-[0.65rem] font-bold shadow-sm">
              {getInitials(user)}
            </div>
            <div className="flex flex-col">
              <span className="text-[0.75rem] text-foreground font-medium leading-tight">{user}</span>
              <span className="text-[0.6rem] text-muted-foreground leading-tight">Operator</span>
            </div>
          </div>
          <button
            onClick={handleThemeToggle}
            className="p-2 border border-border rounded-lg text-muted-foreground hover:border-primary/50 hover:text-primary hover:bg-primary/5 transition-all"
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {isDark ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
          <button
            onClick={handleLogout}
            className="ml-1 p-2 border border-border rounded-lg text-muted-foreground hover:border-red-500/50 hover:text-red-400 hover:bg-red-500/5 transition-all"
            title="Sign out"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* ── LEFT COLUMN ──────────────────────────────────────────────── */}
        <div className="flex-[2] border-r border-border flex flex-col p-4 gap-3 overflow-hidden bg-background">
          {/* Stat cards */}
          <div className="grid grid-cols-4 gap-3 shrink-0">
            {[
              { label: 'Total Requests', value: stats.total, color: 'blue', icon: TrendingUp, sub: `${blockRate}% threat rate` },
              { label: 'Bots Blocked', value: stats.blocked, color: 'red', icon: ShieldAlert, sub: `${stats.total > 0 ? (stats.blocked / stats.total * 100).toFixed(1) : '0.0'}%` },
              { label: 'Humans Passed', value: stats.passed, color: 'green', icon: Users, sub: `${stats.total > 0 ? (stats.passed / stats.total * 100).toFixed(1) : '0.0'}%` },
              { label: 'Honeypot Caught', value: stats.honey, color: 'yellow', icon: Bug, sub: `${honeypotLog.length} logged` },
            ].map((card) => {
              const colorMap: Record<string, { text: string; bg: string; glow: string }> = {
                blue: { text: 'text-blue-400', bg: 'bg-blue-500/10', glow: 'shadow-[inset_0_1px_0_rgba(96,165,250,0.1)]' },
                red: { text: 'text-red-400', bg: 'bg-red-500/10', glow: 'shadow-[inset_0_1px_0_rgba(248,113,113,0.1)]' },
                green: { text: 'text-green-400', bg: 'bg-green-500/10', glow: 'shadow-[inset_0_1px_0_rgba(74,222,128,0.1)]' },
                yellow: { text: 'text-yellow-400', bg: 'bg-yellow-500/10', glow: 'shadow-[inset_0_1px_0_rgba(250,204,21,0.1)]' },
              };
              const c = colorMap[card.color];
              const textColor = card.color === 'blue' ? 'text-foreground' : c.text.replace('400', '500');
              return (
                <div key={card.label} className={`bg-card border border-border rounded-xl p-3.5 flex flex-col gap-2 ${c.glow}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-[0.65rem] text-muted-foreground font-semibold uppercase tracking-wider">{card.label}</span>
                    <div className={`w-7 h-7 rounded-lg ${c.bg} flex items-center justify-center`}>
                      <card.icon className={`w-3.5 h-3.5 ${c.text}`} />
                    </div>
                  </div>
                  <motion.span key={card.value} initial={{ opacity: 0.5, y: -4 }} animate={{ opacity: 1, y: 0 }} className={`text-2xl font-bold ${textColor} tabular-nums`}>
                    {card.value.toLocaleString()}
                  </motion.span>
                  <span className="text-[0.6rem] text-muted-foreground">{card.sub}</span>
                </div>
              );
            })}
          </div>

          {/* Tab Selector */}
          <div className="flex border-b border-border shrink-0 gap-6 px-1">
            {[
              { id: 'feed', label: 'Live Feed' },
              { id: 'map', label: 'Attack Map' },
              { id: 'analytics', label: 'Analytics' },
              { id: 'admin', label: '🛡 Admin' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as 'feed' | 'map' | 'analytics' | 'admin')}
                className={`py-2 text-[0.8rem] font-semibold tracking-wider transition-all duration-200 border-b-2 -mb-[2px] ${activeTab === tab.id
                    ? 'border-blue-500 text-white font-bold'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          {activeTab === 'feed' && (
            <div className="flex-1 flex flex-col gap-3 min-h-0 overflow-hidden">
              {/* Live request feed */}
              <div className="flex-1 bg-card border border-border rounded-xl flex flex-col overflow-hidden">
                <div className="px-3.5 py-2.5 border-b border-border bg-card flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isRunning && <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
                    <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground">Live Request Feed</span>
                    <span className="text-[0.6rem] text-muted-foreground/60 font-mono">{requests.length} entries</span>
                  </div>
                  <div className="flex gap-1.5">
                    <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-green-500/15 text-green-400 border border-green-500/10">ALLOW</span>
                    <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-red-500/15 text-red-400 border border-red-500/10">BLOCK</span>
                    <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-blue-500/15 text-blue-400 border border-blue-500/10">CAPTCHA</span>
                    <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-yellow-500/15 text-yellow-400 border border-yellow-500/10">HONEY</span>
                  </div>
                </div>
                {/* Column headers */}
                <div className="px-3.5 py-1.5 border-b border-border/50 flex items-center gap-3 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  <span className="w-20 shrink-0">Time</span>
                  <span className="w-12 shrink-0 text-center">Action</span>
                  <span className="w-16">User</span>
                  <span className="w-20">Train</span>
                  <span className="w-20">Route</span>
                  <span className="ml-auto">Score</span>
                </div>
                <div className="flex-1 overflow-y-auto px-2 py-1 font-mono text-[0.73rem] flex flex-col gap-1 dashboard-scrollbar">
                  <AnimatePresence initial={false}>
                    {requests.map(req => (
                      <motion.div
                        key={req.id}
                        initial={{ opacity: 0, x: -12, scale: 0.98 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                        className={`flex items-center gap-3 px-2 py-1.5 rounded-lg border transition-colors ${req.type === 'ALLOW' ? 'bg-green-500/[0.04] border-green-500/10 hover:bg-green-500/[0.08]' :
                            req.type === 'BLOCK' ? 'bg-red-500/[0.04] border-red-500/10 hover:bg-red-500/[0.08]' :
                              req.type === 'CAPTCHA' ? 'bg-blue-500/[0.04] border-blue-500/10 hover:bg-blue-500/[0.08]' :
                                'bg-yellow-500/[0.04] border-yellow-500/10 hover:bg-yellow-500/[0.08]'
                          }`}
                      >
                        <span className="text-muted-foreground/70 w-20 shrink-0 text-[0.7rem]">{req.timestamp}</span>
                        <span className={`px-1.5 py-0.5 rounded-md text-[0.6rem] font-bold w-14 text-center shrink-0 ${req.type === 'ALLOW' ? 'bg-green-500/20 text-green-400' :
                            req.type === 'BLOCK' ? 'bg-red-500/20 text-red-400' :
                              req.type === 'CAPTCHA' ? 'bg-blue-500/20 text-blue-400' :
                                'bg-yellow-500/20 text-yellow-400'
                          }`}>
                          {req.type}
                        </span>
                        <span className="text-foreground/90 w-16 text-[0.7rem]">{req.user_id}</span>
                        <span className="text-muted-foreground/70 w-20 text-[0.7rem]">{req.train_id}</span>
                        <span className="text-muted-foreground/70 w-20 text-[0.7rem]">{req.route}</span>
                        <span className="ml-auto flex items-center gap-1.5">
                          <span className={`font-bold text-[0.75rem] tabular-nums ${req.score > 70 ? 'text-red-400' : req.score > 40 ? 'text-yellow-400' : 'text-green-400'}`}>{req.score}</span>
                          {/* Mini score bar */}
                          <div className="w-10 h-1.5 rounded-full bg-border overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${req.score > 70 ? 'bg-red-500' : req.score > 40 ? 'bg-yellow-500' : 'bg-green-500'}`}
                              style={{ width: `${req.score}%` }}
                            />
                          </div>
                        </span>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                  {requests.length === 0 && (
                    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground/50 py-8">
                      <Activity className="w-8 h-8" />
                      <span className="text-xs">Start simulation to see live requests</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Attack Heatmap */}
              <div className="h-20 bg-card border border-border rounded-xl p-3 flex flex-col gap-1.5 shrink-0">
                <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground shrink-0">
                  Attack Heatmap — Last 60s
                </span>
                <div className="flex-1 flex items-end gap-0.5">
                  {heatmapData.map((val, i) => {
                    const max = Math.max(...heatmapData, 1);
                    const pct = val / max;
                    const bg =
                      pct === 0 ? 'bg-border/40'
                        : pct < 0.25 ? 'bg-yellow-500/30'
                          : pct < 0.5 ? 'bg-orange-500/50'
                            : pct < 0.75 ? 'bg-red-500/70'
                              : 'bg-red-500';
                    const nowSlot = Math.floor(Date.now() / 1000) % 60;
                    const isNow = i === nowSlot;
                    return (
                      <div
                        key={i}
                        title={`t-${59 - i}s: ${val} attacks`}
                        className={`flex-1 rounded-sm transition-all duration-300 ${bg} ${isNow ? 'ring-1 ring-blue-400/60' : ''}`}
                        style={{ height: `${Math.max(pct * 100, val > 0 ? 15 : 5)}%` }}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Traffic chart + Pie chart row */}
              <div className="flex gap-3 h-48 shrink-0">
                {/* Line chart — existing */}
                <div className="flex-[2] bg-card border border-border rounded-xl p-3.5 flex flex-col">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground">Live Traffic — Last 30s</span>
                    <div className="flex items-center gap-3 text-[0.6rem]">
                      <div className="flex items-center gap-1.5">
                        <div className="w-3 h-[2px] rounded-full bg-red-500" />
                        <span className="text-muted-foreground">Bots</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-3 h-[2px] rounded-full bg-green-500 opacity-70" style={{ backgroundImage: 'repeating-linear-gradient(90deg, #22c55e 0, #22c55e 3px, transparent 3px, transparent 5px)' }} />
                        <span className="text-muted-foreground">Genuine</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 w-full min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={timeSeriesData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="time" stroke="#475569" fontSize={9} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                        <YAxis stroke="#475569" fontSize={9} tickLine={false} axisLine={false} allowDecimals={false} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '10px', fontSize: '0.7rem', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
                          labelStyle={{ color: '#94a3b8', fontSize: '0.65rem', marginBottom: 4 }}
                        />
                        <Line type="monotone" dataKey="bots" stroke="#ef4444" strokeWidth={2} dot={false} name="Bot Traffic" animationDuration={300} />
                        <Line type="monotone" dataKey="genuine" stroke="#22c55e" strokeWidth={2} strokeDasharray="6 3" dot={false} name="Genuine Traffic" animationDuration={300} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Pie chart — Bots vs Humans */}
                <div className="flex-1 bg-card border border-border rounded-xl p-3.5 flex flex-col">
                  <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Traffic Split</span>
                  <div className="flex-1 w-full min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={[
                            { name: 'Humans', value: stats.passed || 0 },
                            { name: 'Bots', value: (stats.blocked || 0) + (stats.honey || 0) },
                          ]}
                          cx="50%"
                          cy="45%"
                          innerRadius="30%"
                          outerRadius="55%"
                          paddingAngle={3}
                          dataKey="value"
                          animationDuration={400}
                        >
                          <Cell fill="#22c55e" opacity={0.85} />
                          <Cell fill="#ef4444" opacity={0.85} />
                        </Pie>
                        <Tooltip
                          contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '0.65rem' }}
                          formatter={(value: number, name: string) => [value.toLocaleString(), name]}
                        />
                        <Legend
                          iconSize={8}
                          wrapperStyle={{ fontSize: '0.6rem', paddingTop: '4px' }}
                          formatter={(value) => <span style={{ color: '#64748b' }}>{value}</span>}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'map' && (
            <div className="h-[500px] w-full shrink-0">
              <IndiaMap dots={mapDots} center={[22.5, 82.5]} zoom={4.8} />
            </div>
          )}

          {activeTab === 'analytics' && (
            <div className="flex-1 flex flex-col gap-4 overflow-y-auto pr-1 dashboard-scrollbar min-h-0">
              {/* Upper row: Charts side-by-side */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 shrink-0">
                {/* Bot catch rate line chart */}
                <div className="bg-card border border-border rounded-xl p-3.5 flex flex-col h-64">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex flex-col">
                      <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground">Bot Catch Rate</span>
                      <span className="text-[0.55rem] text-muted-foreground/60">Percentage of traffic identified as threats</span>
                    </div>
                    {timeSeriesData.length > 0 && (
                      <span className="text-xs font-bold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                        {timeSeriesData[timeSeriesData.length - 1].rate}% Current
                      </span>
                    )}
                  </div>
                  <div className="flex-1 w-full min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={timeSeriesData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="time" stroke="#475569" fontSize={9} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                        <YAxis stroke="#475569" fontSize={9} tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '10px', fontSize: '0.7rem', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
                          labelStyle={{ color: '#94a3b8', fontSize: '0.65rem', marginBottom: 4 }}
                          formatter={(value) => [`${value}%`, 'Catch Rate']}
                        />
                        <Line type="monotone" dataKey="rate" stroke="#3b82f6" strokeWidth={2.5} dot={false} name="Catch Rate" animationDuration={300} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Action distribution donut chart */}
                <div className="bg-card border border-border rounded-xl p-3.5 flex flex-col h-64">
                  <div className="flex flex-col mb-2">
                    <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground">Action Distribution</span>
                    <span className="text-[0.55rem] text-muted-foreground/60">Breakdown of system intervention decisions</span>
                  </div>
                  <div className="relative flex-1 w-full min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Tooltip
                          contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '10px', fontSize: '0.7rem' }}
                        />
                        <Pie
                          data={[
                            { name: 'ALLOW', value: stats.passed, color: '#10b981' },
                            { name: 'HONEYPOT', value: stats.honey, color: '#eab308' },
                            { name: 'BLOCK', value: stats.blocked, color: '#ef4444' }
                          ]}
                          cx="50%"
                          cy="45%"
                          innerRadius={55}
                          outerRadius={75}
                          paddingAngle={4}
                          dataKey="value"
                        >
                          {[
                            { name: 'ALLOW', value: stats.passed, color: '#10b981' },
                            { name: 'HONEYPOT', value: stats.honey, color: '#eab308' },
                            { name: 'BLOCK', value: stats.blocked, color: '#ef4444' }
                          ].map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Legend verticalAlign="bottom" height={36} iconSize={8} iconType="circle" wrapperStyle={{ fontSize: '0.65rem' }} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none" style={{ transform: 'translateY(-20px)' }}>
                      <span className="text-[0.55rem] text-muted-foreground font-semibold uppercase tracking-wider">Total</span>
                      <span className="text-base font-bold text-foreground tabular-nums">{stats.total}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Lower row: Top Flagged IPs List */}
              <div className="bg-card border border-border rounded-xl flex flex-col overflow-hidden min-h-0">
                <div className="px-3.5 py-2.5 border-b border-border flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <Users className="w-3.5 h-3.5 text-blue-400" />
                    <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground">Top Flagged IPs</span>
                  </div>
                  <span className="text-[0.6rem] text-muted-foreground/60 font-mono">Ranked by blocked requests count</span>
                </div>
                {/* Table headers */}
                <div className="px-3.5 py-1.5 border-b border-border/50 flex items-center gap-3 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground/60 shrink-0">
                  <span className="w-10 shrink-0 text-center">Rank</span>
                  <span className="w-32">IP Address</span>
                  <span className="w-32">Region</span>
                  <span className="ml-auto text-right">Block Events</span>
                </div>
                <div className="overflow-y-auto px-2 py-1 font-mono text-[0.73rem] flex flex-col gap-1 max-h-60 dashboard-scrollbar">
                  {topIps.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground/50 py-8">
                      <ShieldAlert className="w-8 h-8" />
                      <span className="text-xs">No flagged IP data available yet</span>
                    </div>
                  ) : (
                    topIps.map((ipData, i) => (
                      <div
                        key={ipData.ip}
                        className="flex items-center gap-3 px-2 py-1.5 rounded-lg border border-border/30 bg-card/40 hover:bg-card/80 transition-colors"
                      >
                        <span className="w-10 shrink-0 text-center text-muted-foreground/60 font-bold">#{i + 1}</span>
                        <span className="w-32 text-foreground font-semibold">{ipData.ip}</span>
                        <span className="w-32 text-muted-foreground/80">{ipData.region}</span>
                        <span className="ml-auto font-bold text-red-400 text-right tabular-nums">{ipData.count}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── ADMIN ANALYTICS TAB ──────────────────────────────────── */}
          {activeTab === 'admin' && (
            <div className="flex-1 flex flex-col gap-4 overflow-y-auto pr-1 dashboard-scrollbar min-h-0">
              {/* Summary Cards */}
              <div className="grid grid-cols-3 gap-3 shrink-0">
                <div className="bg-card border border-border rounded-xl p-3.5 flex flex-col gap-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Clock className="w-3.5 h-3.5 text-orange-400" />
                    <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Peak Attack Hour</span>
                  </div>
                  <span className="text-2xl font-bold text-orange-400 tabular-nums">
                    {analytics?.peak_attack_hour != null ? `${String(analytics.peak_attack_hour).padStart(2, '0')}:00` : '--:--'}
                  </span>
                  <span className="text-[0.6rem] text-muted-foreground">{analytics?.peak_attack_count ?? 0} attacks in peak hour</span>
                </div>
                <div className="bg-card border border-border rounded-xl p-3.5 flex flex-col gap-1">
                  <div className="flex items-center gap-2 mb-1">
                    <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                    <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Top Attacking IP</span>
                  </div>
                  <span className="text-base font-bold text-red-400 font-mono truncate">
                    {analytics?.top_attacking_ips?.[0]?.ip ?? 'None yet'}
                  </span>
                  <span className="text-[0.6rem] text-muted-foreground">{analytics?.top_attacking_ips?.[0]?.count ?? 0} blocked requests</span>
                </div>
                <div className="bg-card border border-border rounded-xl p-3.5 flex flex-col gap-1">
                  <div className="flex items-center gap-2 mb-1">
                    <MapPin className="w-3.5 h-3.5 text-yellow-400" />
                    <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Most Targeted Route</span>
                  </div>
                  <span className="text-base font-bold text-yellow-400 truncate">
                    {analytics?.top_targeted_routes?.[0]?.route ?? 'None yet'}
                  </span>
                  <span className="text-[0.6rem] text-muted-foreground">{analytics?.top_targeted_routes?.[0]?.count ?? 0} bot attacks</span>
                </div>
              </div>

              {/* Hourly attack bar chart */}
              <div className="bg-card border border-border rounded-xl p-3.5 flex flex-col h-52 shrink-0">
                <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground mb-2">Hourly Attack Distribution (Today)</span>
                <div className="flex-1 min-h-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={(analytics?.hourly_attacks ?? Array(24).fill(0)).map((v, i) => ({ hour: `${i}h`, attacks: v }))} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="hour" stroke="#475569" fontSize={8} tickLine={false} axisLine={false} interval={1} />
                      <YAxis stroke="#475569" fontSize={9} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '0.7rem' }} />
                      <Bar dataKey="attacks" fill="#ef4444" radius={[3, 3, 0, 0]} opacity={0.8} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Top IPs + Top Routes side by side */}
              <div className="grid grid-cols-2 gap-4 shrink-0">
                {/* Top IPs */}
                <div className="bg-card border border-border rounded-xl flex flex-col overflow-hidden">
                  <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2">
                    <ListOrdered className="w-3.5 h-3.5 text-red-400" />
                    <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground">Top Attacking IPs</span>
                  </div>
                  <div className="p-2 flex flex-col gap-1">
                    {(analytics?.top_attacking_ips ?? []).length === 0 ? (
                      <span className="text-[0.65rem] text-muted-foreground/50 p-2">No data yet</span>
                    ) : (
                      (analytics?.top_attacking_ips ?? []).map((entry, i) => (
                        <div key={entry.ip} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-red-500/[0.04] border border-red-500/10">
                          <span className="text-[0.6rem] text-muted-foreground/50 w-5">#{i + 1}</span>
                          <span className="flex-1 font-mono text-[0.7rem] text-red-400/90 truncate">{entry.ip}</span>
                          <span className="text-[0.7rem] font-bold text-red-400 tabular-nums">{entry.count}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                {/* Top Routes */}
                <div className="bg-card border border-border rounded-xl flex flex-col overflow-hidden">
                  <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2">
                    <MapPin className="w-3.5 h-3.5 text-yellow-400" />
                    <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground">Most Targeted Routes</span>
                  </div>
                  <div className="p-2 flex flex-col gap-1">
                    {(analytics?.top_targeted_routes ?? []).length === 0 ? (
                      <span className="text-[0.65rem] text-muted-foreground/50 p-2">No data yet</span>
                    ) : (
                      (analytics?.top_targeted_routes ?? []).map((entry, i) => (
                        <div key={entry.route} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-yellow-500/[0.04] border border-yellow-500/10">
                          <span className="text-[0.6rem] text-muted-foreground/50 w-5">#{i + 1}</span>
                          <span className="flex-1 text-[0.7rem] text-yellow-400/90 truncate">{entry.route}</span>
                          <span className="text-[0.7rem] font-bold text-yellow-400 tabular-nums">{entry.count}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT COLUMN ─────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col p-4 gap-3 overflow-y-auto dashboard-scrollbar bg-background">
          {/* ── ALERT BANNER ────────────────────────────────────── */}
          <AnimatePresence>
            {alert?.alert_active && (
              <motion.div
                initial={{ opacity: 0, y: -8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.97 }}
                className="bg-red-500/10 border border-red-500/40 rounded-xl p-3.5 flex flex-col gap-2 shrink-0"
              >
                <div className="flex items-center gap-2">
                  <Bell className="w-4 h-4 text-red-400 animate-pulse" />
                  <span className="text-[0.75rem] font-bold text-red-400 uppercase tracking-wider">🚨 Bot Attack Detected</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.65rem] font-mono">
                  <span className="text-muted-foreground">Requests/sec: <span className="text-red-300 font-bold">{alert.requests_per_sec}</span></span>
                  <span className="text-muted-foreground">Blocked Bots: <span className="text-red-300 font-bold">{alert.blocked_bots}</span></span>
                  <span className="text-muted-foreground">Affected Route: <span className="text-red-300 font-bold">{alert.affected_route}</span></span>
                  <span className="text-muted-foreground">Top IP: <span className="text-red-300 font-bold">{alert.top_ip}</span></span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {/* Simulation controls */}
          <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-3.5 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center">
                  <Zap className="w-3 h-3 text-primary" />
                </div>
                <span className="text-[0.75rem] font-semibold text-foreground">Simulation Controls</span>
              </div>
              <div className={`px-2.5 py-1 rounded-full text-[0.6rem] font-bold flex items-center gap-1.5 uppercase tracking-wider transition-colors ${isRunning
                  ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                  : 'bg-card text-muted-foreground border border-border'
                }`}>
                {isRunning && <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />}
                {isRunning ? 'Running' : 'Stopped'}
              </div>
            </div>            <button
              onClick={handleToggleSimulation}
              className={`w-full py-2.5 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all duration-200 ${isRunning
                  ? 'bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 hover:border-red-500/50'
                  : 'bg-gradient-to-r from-blue-600 to-blue-500 text-white hover:from-blue-500 hover:to-blue-400 shadow-[0_2px_12px_rgba(59,130,246,0.3)]'
                }`}
            >
              {isRunning ? <><Square className="w-3.5 h-3.5" fill="currentColor" /> Stop Simulation</> : <><Play className="w-3.5 h-3.5" fill="currentColor" /> Start Simulation</>}
            </button>
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between text-[0.7rem]">
                <span className="text-muted-foreground">Requests / Second</span>
                <span className="font-bold text-foreground bg-card border border-border rounded px-2 py-0.5 text-[0.65rem] tabular-nums">{rps} RPS</span>
              </div>
              <input
                type="range"
                min="1" max="50"
                value={rps}
                onChange={(e) => setRps(Number(e.target.value))}
                className="w-full accent-primary h-1.5"
                disabled={isRunning}
              />
              <div className="flex justify-between text-[0.55rem] text-muted-foreground/50">
                <span>1</span>
                <span>25</span>
                <span>50</span>
              </div>
            </div>
          </div>

          {/* Agent Status */}
          <div className="flex flex-col gap-1.5 shrink-0">
            <div className="flex items-center justify-between px-0.5 mb-0.5">
              <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">Agent Status</span>
              <span className="text-[0.55rem] text-green-500 font-semibold">5/5 ONLINE</span>
            </div>
            {[
              { name: "Booking Behavior", icon: Activity, processed: stats.total, desc: "Pattern analysis" },
              { name: "Bot Scorer", icon: Target, processed: stats.total, desc: "Risk scoring" },
              { name: "Honeypot", icon: Database, processed: stats.honey, desc: "Trap deployment" },
              { name: "Blacklist Mgr", icon: Ban, processed: stats.blocked, desc: "IP blocking" },
              { name: "Fairness Monitor", icon: Scale, processed: stats.total, desc: "Queue integrity" }
            ].map(agent => (
              <div key={agent.name} className="bg-card border border-border rounded-lg p-2.5 flex items-center gap-2.5 group hover:border-primary/20 transition-colors">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0 group-hover:bg-primary/15 transition-colors">
                  <agent.icon className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[0.75rem] font-semibold text-foreground truncate leading-tight">{agent.name}</div>
                  <div className="text-[0.6rem] text-muted-foreground/60 leading-tight">{agent.desc}</div>
                </div>
                <div className="flex flex-col items-end gap-0.5 shrink-0">
                  <div className="flex items-center gap-1 text-[0.55rem] text-green-500/80 font-bold uppercase tracking-wider">
                    <div className="w-1 h-1 rounded-full bg-green-500" /> ON
                  </div>
                  <div className="text-[0.6rem] text-muted-foreground/60 font-mono tabular-nums">{agent.processed.toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Blacklist + Honeypot panels */}
          <div className="flex-1 flex flex-col gap-3 min-h-[280px]">
            <div className="flex-1 bg-card border border-border rounded-xl flex flex-col overflow-hidden">
              <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
                <Ban className="w-3 h-3 text-red-400" />
                <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">Top 10 Blocked IDs</span>
                <span className="ml-auto text-[0.55rem] text-muted-foreground/50 font-mono">{blacklist.length} IPs</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 font-mono text-[0.68rem] flex flex-col gap-0.5 dashboard-scrollbar">
                {blacklist.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-muted-foreground/40 py-4">
                    <ShieldAlert className="w-6 h-6" />
                    <span className="text-[0.65rem]">No IPs blacklisted yet</span>
                  </div>
                ) : (
                  blacklist.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1.5 hover:bg-red-500/[0.03] rounded-md transition-colors">
                      <span className="text-muted-foreground/40 text-[0.6rem] w-4 tabular-nums shrink-0">#{i + 1}</span>
                      <span className="text-red-400/80 flex-1 truncate">⛔ {entry.ip}</span>
                      <span className="text-red-400/60 text-[0.6rem] font-bold tabular-nums shrink-0">{entry.count}x</span>
                      <span className="text-muted-foreground/40 text-[0.55rem] shrink-0">{entry.last_seen}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex-1 bg-card border border-border rounded-xl flex flex-col overflow-hidden">
              <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
                <Bug className="w-3 h-3 text-yellow-400" />
                <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">Honeypot Log</span>
                <span className="ml-auto text-[0.55rem] text-muted-foreground/50 font-mono">{honeypotLog.length} traps</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 font-mono text-[0.68rem] flex flex-col gap-0.5 dashboard-scrollbar">
                {honeypotLog.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-muted-foreground/40 py-4">
                    <Database className="w-6 h-6" />
                    <span className="text-[0.65rem]">No traps triggered yet</span>
                  </div>
                ) : (
                  honeypotLog.map((entry) => (
                    <div
                      key={entry.id}
                      className={`flex justify-between items-center px-2 py-1.5 rounded-md transition-colors gap-2 ${entry.isConfirmed
                          ? "bg-red-500/10 border border-red-500/20 text-red-400 font-bold"
                          : "hover:bg-yellow-500/[0.03] text-yellow-400/80"
                        }`}
                    >
                      <span className="truncate">
                        {entry.isConfirmed ? "🚨 " : "🍯 "}
                        {entry.text}
                      </span>
                      <span className="text-muted-foreground/50 shrink-0 text-[0.6rem]">
                        {entry.time}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* ── FAIR QUEUE PANEL ─────────────────────────────────── */}
          <div className="flex-1 bg-card border border-border rounded-xl flex flex-col overflow-hidden min-h-[160px]">
            <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
              <Scale className="w-3 h-3 text-green-400" />
              <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">Fair Queue — Genuine Users</span>
              <span className="ml-auto text-[0.55rem] text-green-400/60 font-mono">{queueEntries.length} in queue</span>
            </div>
            {/* Column headers */}
            <div className="px-3 py-1 border-b border-border/40 flex items-center gap-2 text-[0.58rem] font-semibold uppercase tracking-wider text-muted-foreground/50 shrink-0">
              <span className="w-8 shrink-0 text-center">Pos</span>
              <span className="flex-1">User</span>
              <span className="w-16 text-right">Priority</span>
              <span className="w-16 text-right">Wait</span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 font-mono text-[0.68rem] flex flex-col gap-0.5 dashboard-scrollbar">
              {queueEntries.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-muted-foreground/40 py-4">
                  <Scale className="w-6 h-6" />
                  <span className="text-[0.65rem]">No users in queue yet</span>
                </div>
              ) : (
                queueEntries.slice(0, 12).map((entry, i) => (
                  <div key={`${entry.user_id}-${i}`} className="flex items-center gap-2 px-2 py-1 rounded-md bg-green-500/[0.03] border border-green-500/10 hover:bg-green-500/[0.07] transition-colors">
                    <span className="w-8 shrink-0 text-center text-green-400/50 font-bold text-[0.6rem]">#{entry.queue_position}</span>
                    <span className="flex-1 text-green-400/80 truncate">{entry.user_id}</span>
                    <span className="w-16 text-right text-blue-400/70 tabular-nums">{entry.priority_score}</span>
                    <span className="w-16 text-right text-muted-foreground/60">{entry.estimated_wait}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>

      {/* ── FOOTER STATUS BAR ─────────────────────────────────────────── */}
      <footer className="h-7 border-t border-border bg-card/50 flex items-center justify-between px-6 text-[0.6rem] text-muted-foreground/60 font-mono shrink-0">
        <div className="flex items-center gap-4">
          <span>STG v1.0.0</span>
          <span>•</span>
          <span>{dataSource === 'ws' ? '🟢 WebSocket' : dataSource === 'mock' ? '🟡 Mock Data' : '⚫ Disconnected'}</span>
        </div>
        <div className="flex items-center gap-4">
          <span>Agents: 5/5</span>
          <span>•</span>
          <span>Uptime: {new Date().toLocaleTimeString('en-US', { hour12: false })}</span>
        </div>
      </footer>

      <style dangerouslySetInnerHTML={{
        __html: `
        .dashboard-scrollbar::-webkit-scrollbar { width: 5px; }
        .dashboard-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .dashboard-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 9999px; }
        .dashboard-scrollbar::-webkit-scrollbar-thumb:hover { background: #334155; }
        input[type="range"]::-webkit-slider-thumb { cursor: pointer; }
        input[type="range"]:disabled { opacity: 0.4; }
      `}} />
    </div>
  );
}
