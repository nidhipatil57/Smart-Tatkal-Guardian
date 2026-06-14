import asyncio
import json
import os
import random
from collections import deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from profiles import generate_bot_profile, generate_human_profile
from sender import send_request


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield  # startup / shutdown hook (keeps event loop alive)

app = FastAPI(title="Smart Tatkal Guardian — Simulator", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", response_class=HTMLResponse)
async def get_landing():
    """Serve the premium landing page from the root directory."""
    path = os.path.join(os.path.dirname(__file__), "..", "landing.html")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse(content="<h1>Smart Tatkal Guardian — Simulator</h1><p>landing.html not found</p>", status_code=404)

# ── In-memory state ──────────────────────────────────────────────────────────
running: bool = False
sent_count: int = 0
bot_count: int = 0
human_count: int = 0
request_log: deque = deque(maxlen=100)   # includes is_bot — internal only
_bg_task: asyncio.Task | None = None

# ── WebSocket clients ────────────────────────────────────────────────────────
_ws_clients: set[WebSocket] = set()


async def _broadcast(data: dict) -> None:
    """Send a JSON event to all connected dashboard WebSocket clients."""
    if not _ws_clients:
        return
    msg = json.dumps(data)
    dead = set()
    for ws in _ws_clients:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.add(ws)
    _ws_clients.difference_update(dead)


# ── Background generator ─────────────────────────────────────────────────────
async def _generate_traffic(rps: int):
    global running, sent_count, bot_count, human_count

    delay = 1.0 / max(rps, 1)

    while running:
        # 80% bots, 20% humans
        if random.random() < 0.80:
            profile = generate_bot_profile()
            bot_count += 1
        else:
            profile = generate_human_profile()
            human_count += 1

        sent_count += 1
        request_log.append(profile)          # full profile with is_bot
        result = await send_request(profile) # returns scorer response dict or None

        # Broadcast to dashboard WebSocket clients
        if result and isinstance(result, dict):
            await _broadcast({
                "type": "event",
                "user_id": result.get("user_id", profile.get("user_id")),
                "action": result.get("action", "UNKNOWN"),
                "bot_probability": result.get("bot_probability", 0),
                "flags": result.get("flags", []),
                "risk_level": result.get("risk_level", ""),
                "time": result.get("timestamp", 0) * 1000,  # ms for JS
            })

        await asyncio.sleep(delay)


# ── Endpoints ────────────────────────────────────────────────────────────────
@app.post("/simulate/start")
async def start_simulation(rps: int = 10):
    global running, _bg_task, sent_count, bot_count, human_count

    if running:
        return {"status": "already_running", "rps": rps}

    # Reset counters on fresh start
    sent_count = 0
    bot_count = 0
    human_count = 0
    request_log.clear()

    running = True
    loop = asyncio.get_event_loop()
    _bg_task = loop.create_task(_generate_traffic(rps))
    print(f"[simulator] Started — {rps} req/sec")
    return {"status": "started", "rps": rps}


@app.post("/simulate/stop")
async def stop_simulation():
    global running, _bg_task

    running = False
    if _bg_task:
        _bg_task.cancel()
        _bg_task = None

    print(f"[simulator] Stopped — total sent: {sent_count}")
    return {"status": "stopped", "sent_count": sent_count}


@app.get("/simulate/status")
async def get_status():
    return {
        "running": running,
        "sent_count": sent_count,
        "bot_count": bot_count,
        "human_count": human_count,
    }


@app.get("/simulate/replay")
async def replay():
    """Returns last 100 requests including is_bot field (internal use only)."""
    return list(request_log)


# ── WebSocket ─────────────────────────────────────────────────────────────────
@app.websocket("/ws/events")
async def ws_events(websocket: WebSocket):
    """Dashboard connects here to receive real-time scoring events."""
    await websocket.accept()
    _ws_clients.add(websocket)
    try:
        while True:
            # Keep connection alive; client doesn't need to send anything
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(websocket)
