# Smart Tatkal Guardian — Scoring Engine (Person 2)

> **Your job:** Receive a snapshot of user behavior, decide if it's a bot,
> and if you're not sure — trap it. This document tells you exactly how the
> code works and what you need to do to run, test, and demo it.

---

## Table of Contents

1. [What This Service Does](#what-this-service-does)
2. [File-by-File Breakdown](#file-by-file-breakdown)
3. [How the Scoring Works](#how-the-scoring-works)
4. [How the Honeypot Works](#how-the-honeypot-works)
5. [API Reference](#api-reference)
6. [How to Run](#how-to-run)
7. [How to Test Manually](#how-to-test-manually)
8. [Demo Script (Day 3)](#demo-script-day-3)
9. [Integration with Other Teammates](#integration-with-other-teammates)
10. [Common Mistakes to Avoid](#common-mistakes-to-avoid)

---

## What This Service Does

This is a **FastAPI server running on `localhost:8002`**.

It receives a JSON payload from the orchestrator (Person 3) that describes
*how* a user behaved on the IRCTC booking page — how fast they clicked,
whether the mouse moved, how many requests came from the same IP, etc.

It outputs a **bot probability score** between `0.0` and `1.0`, a **risk
level**, and an **action** the orchestrator should take.

The novel part: if the score lands in the "suspicious but not certain" range,
the user is dropped into a **honeypot** — they get a fake booking confirmation
with a fake PNR number. If they confirm it (bots always do, humans don't),
they get flagged. After 3 fake confirmations, they're permanently blacklisted.

---

## File-by-File Breakdown

```
scorer/
├── main.py          ← FastAPI app. All 5 HTTP endpoints live here.
├── scorer.py        ← Pure scoring logic. No FastAPI, no state. Easy to test.
├── honeypot.py      ← Tracks who is in a honeypot, handles fake confirmations.
├── blacklist.py     ← In-memory set of permanently banned user_ids.
└── requirements.txt ← fastapi, uvicorn, pydantic
```

### `scorer.py` — The Brain

Contains a single function `score(behavioral: dict) -> ScoreResult`.

- Takes the raw behavioral dict from the request.
- Loops over 5 features, calculates a weighted penalty for each.
- Penalties are **continuous** (not binary): a request arriving at 300ms
  gets a partial penalty, not full. This is more realistic.
- Returns a `ScoreResult` dataclass with `bot_probability`, `risk_level`,
  `action`, `flags`, and `feature_scores` (per-feature breakdown).

### `honeypot.py` — The Trap

Maintains `_sessions: dict[str, HoneypotSession]` in memory.

- `activate(user_id)` — called when action=HONEYPOT. Generates a fake PNR
  like `TKL2947381029`, stores it. Returns the fake PNR.
- `confirm(user_id)` — called when a user tries to confirm their booking.
  Increments `confirm_count`. At 3 hits → sets `confirmed_bot=True` and
  calls `blacklist.add(user_id)`.
- Returns a full fake booking payload (train name, coach, seat, departure)
  that looks completely real. Bots parse this and move on. Humans try to
  look up the PNR and realize it doesn't exist.

### `blacklist.py` — The Ban List

Just a Python `set` wrapped in 4 functions: `add`, `is_blacklisted`,
`all_entries`, `clear`. Simple. Fast. Thread-safe for async.

### `main.py` — The API Layer

Wires everything together. Key logic:

1. Every `/score` request first checks the blacklist — if already banned,
   returns `BLOCK` immediately without even scoring.
2. Calls `scorer.score()`.
3. If action is `HONEYPOT`, calls `honeypot.activate()` to arm the trap.
4. Updates global counters (`_stats` dict).

---

## How the Scoring Works

Five behavioral features are evaluated. Each fires a penalty between `0.0`
(clean) and its full weight (fully bot-like):

| Feature | Bot Signal | Weight | Flag |
|---|---|---|---|
| `time_since_last_request_ms` | < 500ms | 0.30 | `RAPID_FIRE` |
| `mouse_movement_score` | < 0.2 | 0.20 | `NO_MOUSE` |
| `typing_speed_cpm` | ≈ 0 | 0.15 | `NO_TYPING` |
| `ip_request_count` | > 10 | 0.20 | `SHARED_IP` |
| `requests_per_minute` | > 20 | 0.15 | `RATE_BURST` |

**Score = sum of weighted penalties, clamped to [0.0, 1.0]**

> **Missing features are treated as fully bot-like.** If the simulator
> doesn't send `mouse_movement_score`, it counts as 0 (worst case). This
> is intentional — absence of data is itself suspicious.

### Risk Levels

| Score Range | Risk Level | Action |
|---|---|---|
| 0.00 – 0.30 | LOW | ALLOW |
| 0.30 – 0.60 | MEDIUM | SLOW_QUEUE |
| 0.60 – 0.85 | HIGH | HONEYPOT |
| 0.85 – 1.00 | CRITICAL | BLOCK |

---

## How the Honeypot Works

```
Simulator sends bot request
        │
        ▼
POST /score  →  bot_probability=0.72  →  action=HONEYPOT
        │
        ▼
honeypot.activate("USR_BOT1")
  → generates fake_pnr = "TKL2947381029"
  → stores in _sessions["USR_BOT1"]
        │
        ▼
Orchestrator serves fake booking page to the bot
        │
        ▼
Bot clicks "Confirm Booking" (it always does)
        │
        ▼
POST /honeypot/confirm  {"user_id": "USR_BOT1"}
  → confirm_count = 1  (confirmed_bot = False)
  → confirm_count = 2  (confirmed_bot = False)
  → confirm_count = 3  (confirmed_bot = True)
     → blacklist.add("USR_BOT1")
     → future /score calls return BLOCK immediately
```

**Why bots fall for this:**
Bots are scripted to confirm whatever booking page they land on.
They don't fetch the PNR from a real IRCTC API to verify it's valid.
Humans, on the other hand, will see the confirmation, try to check the
PNR on the IRCTC site, get "PNR not found", and stop.

---

## API Reference

### `POST /score`

Score a user's behavioral data.

**Request:**
```json
{
  "request_id": "abc-123",
  "user_id": "USR_1234",
  "behavioral": {
    "time_since_last_request_ms": 200,
    "mouse_movement_score": 0.05,
    "typing_speed_cpm": 0,
    "ip_request_count": 15,
    "requests_per_minute": 30
  }
}
```

**Response:**
```json
{
  "request_id": "abc-123",
  "user_id": "USR_1234",
  "bot_probability": 0.72,
  "risk_level": "HIGH",
  "flags": ["NO_MOUSE", "NO_TYPING", "RAPID_FIRE", "SHARED_IP"],
  "action": "HONEYPOT",
  "timestamp": 1717000000.0
}
```

---

### `POST /honeypot/confirm`

Called when a honeypot user tries to confirm their (fake) booking.
Returns a convincing fake confirmation. If user is NOT in a honeypot,
returns HTTP 404 — the orchestrator should then route to the real booking service.

**Request:**
```json
{ "user_id": "USR_1234" }
```

**Response (honeypot user):**
```json
{
  "honeypot": true,
  "fake_pnr": "TKL2947381029",
  "confirm_count": 1,
  "confirmed_bot": false,
  "booking_status": "CONFIRMED",
  "pnr": "TKL2947381029",
  "train": "12951 RAJDHANI EXP",
  "departure": "2026-06-15T06:00:00",
  "coach": "B4",
  "seat": "37",
  "message": "Your Tatkal ticket has been successfully booked."
}
```

---

### `GET /stats`

Live counters for the dashboard.

```json
{
  "total_scored": 120,
  "bots": 45,
  "humans": 60,
  "slow_queue": 15,
  "honeypot_active": 8,
  "confirmed_bots": 3,
  "blacklisted": 3,
  "timestamp": 1717000000.0
}
```

---

### `GET /blacklist`

Returns all permanently banned user_ids.

```json
{
  "count": 3,
  "user_ids": ["USR_BOT1", "USR_BOT5", "USR_BOT9"],
  "timestamp": 1717000000.0
}
```

---

### `DELETE /reset`

Clears all state: honeypot sessions, blacklist, and counters.
**Use this before every demo run.**

```json
{ "status": "ok", "message": "All state cleared." }
```

---

## How to Run

> **Critical:** You MUST run from inside the `scorer/` directory.
> The modules (`blacklist`, `honeypot`, `scorer`) are relative — running
> from the project root will cause `ModuleNotFoundError`.

```bash
# Step 1: Navigate to the scorer directory
cd "d:\wahab stuff\wahab code\Smart-Tatkal-Guardian\scorer"

# Step 2: Install dependencies (only needed once)
py -m pip install -r requirements.txt

# Step 3: Start the server
py -m uvicorn main:app --port 8002 --reload
```

You should see:
```
INFO:     Uvicorn running on http://127.0.0.1:8002 (Press CTRL+C to quit)
INFO:     Application startup complete.
```

Open `http://localhost:8002/docs` in your browser for the interactive
Swagger UI — you can test every endpoint from there without curl.

---

## How to Test Manually

### Option 1: Run the smoke test script

From the **project root** (not scorer/):
```bash
py smoke_endpoints.py
```

This runs 6 assertions covering all endpoints and the full honeypot pipeline.

### Option 2: Use Swagger UI

1. Start the server.
2. Open `http://localhost:8002/docs`.
3. Click any endpoint → "Try it out" → fill in the JSON → Execute.

### Option 3: curl / PowerShell

**Score a bot:**
```powershell
Invoke-RestMethod -Uri http://localhost:8002/score -Method POST `
  -ContentType "application/json" `
  -Body '{"user_id":"USR_TEST","behavioral":{"time_since_last_request_ms":100,"mouse_movement_score":0.01,"typing_speed_cpm":0,"ip_request_count":50,"requests_per_minute":60}}'
```

**Confirm a honeypot:**
```powershell
Invoke-RestMethod -Uri http://localhost:8002/honeypot/confirm -Method POST `
  -ContentType "application/json" `
  -Body '{"user_id":"USR_TEST"}'
```

**Check stats:**
```powershell
Invoke-RestMethod -Uri http://localhost:8002/stats
```

**Reset before demo:**
```powershell
Invoke-RestMethod -Uri http://localhost:8002/reset -Method DELETE
```

---

## Demo Script (Day 3)

This is the exact sequence to show judges during the live demo.

**Step 0: Reset**
```powershell
Invoke-RestMethod -Uri http://localhost:8002/reset -Method DELETE
```

**Step 1: Send 5 bot requests** (all should return HONEYPOT or BLOCK)
```powershell
# Run this 5 times with different user_ids
Invoke-RestMethod -Uri http://localhost:8002/score -Method POST `
  -ContentType "application/json" `
  -Body '{"user_id":"USR_BOT1","behavioral":{"time_since_last_request_ms":80,"mouse_movement_score":0.0,"typing_speed_cpm":0,"ip_request_count":30,"requests_per_minute":50}}'
```

**Step 2: Trigger honeypot confirmation 3x for one of them**
```powershell
# Run 3 times
Invoke-RestMethod -Uri http://localhost:8002/honeypot/confirm -Method POST `
  -ContentType "application/json" `
  -Body '{"user_id":"USR_BOT1"}'
```
Watch `confirmed_bot` flip to `true` on the 3rd call.

**Step 3: Show the blacklist**
```powershell
Invoke-RestMethod -Uri http://localhost:8002/blacklist
```
`USR_BOT1` should appear.

**Step 4: Prove auto-block works**
```powershell
# Score USR_BOT1 again — should return BLOCK instantly, no scoring needed
Invoke-RestMethod -Uri http://localhost:8002/score -Method POST `
  -ContentType "application/json" `
  -Body '{"user_id":"USR_BOT1","behavioral":{"time_since_last_request_ms":3000,"mouse_movement_score":0.9,"typing_speed_cpm":220}}'
```
Even with clean behavioral data, a blacklisted user gets `BLOCK`. Point this
out to the judges — it's a permanent ban, not per-request scoring.

**Step 5: Show live stats**
```powershell
Invoke-RestMethod -Uri http://localhost:8002/stats
```

---

## Integration with Other Teammates

### What Person 3 (Orchestrator) sends you:

```json
{
  "request_id": "uuid-here",
  "user_id": "USR_xxxx",
  "behavioral": {
    "time_since_last_request_ms": 200,
    "mouse_movement_score": 0.05,
    "typing_speed_cpm": 0,
    "ip_request_count": 15,
    "requests_per_minute": 30
  }
}
```

### What you send back to Person 3:

```json
{
  "request_id": "uuid-here",
  "user_id": "USR_xxxx",
  "bot_probability": 0.72,
  "risk_level": "HIGH",
  "flags": ["NO_MOUSE", "NO_TYPING", "RAPID_FIRE"],
  "action": "HONEYPOT",
  "timestamp": 1717000000.0
}
```

### Person 3's routing logic (their problem, but you should understand it):

| Action | What Person 3 does |
|---|---|
| `ALLOW` | Let the request through to real booking |
| `SLOW_QUEUE` | Add artificial delay before forwarding |
| `HONEYPOT` | Serve a fake booking page; later call your `/honeypot/confirm` |
| `BLOCK` | Reject immediately with HTTP 429 |

### What Person 4 (Dashboard) reads from you:

The dashboard polls `GET /stats` every few seconds to show live charts.
Keep the stats format stable — don't rename any keys.

---

## Common Mistakes to Avoid

**1. Running from the wrong directory**

```bash
# WRONG — will crash with ModuleNotFoundError: No module named 'blacklist'
cd "Smart-Tatkal-Guardian"
py -m uvicorn scorer.main:app --port 8002

# CORRECT
cd "Smart-Tatkal-Guardian/scorer"
py -m uvicorn main:app --port 8002
```

**2. Port already in use**

If you get `WinError 10013`, the server is already running.
Find and kill it:
```powershell
netstat -ano | findstr :8002
# Note the PID in the last column, then:
taskkill /PID <pid> /F
```

**3. Forgetting to reset before a demo**

State is in-memory and persists across requests within a single server run.
Always call `DELETE /reset` before a demo so the counters start from zero.

**4. Sending a score request for a blacklisted user and expecting it to be scored**

Blacklisted users are **short-circuited** in `main.py` — they never reach
`scorer.score()`. The response will always be `bot_probability=1.0 / CRITICAL / BLOCK`
regardless of their behavioral data. This is intentional.

**5. Calling `/honeypot/confirm` for a user who wasn't scored into HONEYPOT**

The endpoint returns HTTP 404 if the user has no active honeypot session.
The orchestrator should treat a 404 as "not a honeypot user, route to real booking."
