"""
main.py — FastAPI Scoring Engine  (runs on localhost:8002)

Endpoints:
  POST /score              → score behavioral data, return risk assessment
  POST /honeypot/confirm   → handle honeypot user's fake-confirm attempt
  GET  /stats              → live counters
  GET  /blacklist          → list of confirmed-bot user_ids
  DELETE /reset            → wipe all in-memory state (demo resets)
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import blacklist
import honeypot
import scorer

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("main")

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Smart Tatkal Guardian — Scoring Engine",
    description=(
        "Weighted rule-based bot detector with honeypot session tracking. "
        "Accepts behavioral telemetry, returns a bot probability score and recommended action."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# In-memory global counters
# ---------------------------------------------------------------------------

_stats = {
    "total_scored": 0,
    "bots": 0,        # HIGH or CRITICAL
    "humans": 0,      # LOW
    "slow_queue": 0,  # MEDIUM
}


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class BehavioralData(BaseModel):
    time_since_last_request_ms: Optional[float] = None
    mouse_movement_score: Optional[float] = None
    typing_speed_cpm: Optional[float] = None
    ip_request_count: Optional[float] = None
    requests_per_minute: Optional[float] = None
    # Allow extra fields from Person 1's sensor layer — they are ignored but accepted
    model_config = {"extra": "allow"}


class ScoreRequest(BaseModel):
    request_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    behavioral: BehavioralData


class ScoreResponse(BaseModel):
    request_id: str
    user_id: str
    bot_probability: float
    risk_level: str
    flags: list[str]
    action: str
    timestamp: float


class HoneypotConfirmRequest(BaseModel):
    request_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/score", response_model=ScoreResponse, summary="Score behavioral data")
async def score_request(req: ScoreRequest) -> ScoreResponse:
    """
    Receive a behavioral telemetry snapshot and return a bot probability score
    plus recommended action (ALLOW / SLOW_QUEUE / HONEYPOT / BLOCK).

    If the user is already on the blacklist, always return BLOCK immediately.
    """
    _stats["total_scored"] += 1

    # Fast-path: already a confirmed bot
    if blacklist.is_blacklisted(req.user_id):
        logger.warning("🚫 Blacklisted user  %s  → auto BLOCK", req.user_id)
        return ScoreResponse(
            request_id=req.request_id,
            user_id=req.user_id,
            bot_probability=1.0,
            risk_level="CRITICAL",
            flags=["BLACKLISTED"],
            action="BLOCK",
            timestamp=time.time(),
        )

    # Score
    behavioral_dict = req.behavioral.model_dump()
    result = scorer.score(behavioral_dict)

    # Update counters
    if result.action in ("HONEYPOT", "BLOCK"):
        _stats["bots"] += 1
    elif result.action == "SLOW_QUEUE":
        _stats["slow_queue"] += 1
    else:
        _stats["humans"] += 1

    # Activate honeypot session if needed
    if result.action == "HONEYPOT":
        fake_pnr = honeypot.activate(req.user_id)
        logger.info(
            "🍯 Honeypot armed  user=%s  fake_pnr=%s  score=%.3f",
            req.user_id, fake_pnr, result.bot_probability,
        )

    logger.info(
        "📊 Scored  user=%-12s  prob=%.3f  level=%-8s  action=%s  flags=%s",
        req.user_id, result.bot_probability, result.risk_level,
        result.action, result.flags,
    )

    return ScoreResponse(
        request_id=req.request_id,
        user_id=req.user_id,
        bot_probability=result.bot_probability,
        risk_level=result.risk_level,
        flags=result.flags,
        action=result.action,
        timestamp=time.time(),
    )


@app.post("/honeypot/confirm", summary="Handle honeypot booking confirmation")
async def honeypot_confirm(req: HoneypotConfirmRequest) -> dict[str, Any]:
    """
    Called when a user in a honeypot session tries to confirm their booking.

    - Returns a convincing-but-fake confirmation payload.
    - After 3 confirmations the user is escalated to CONFIRMED_BOT + blacklisted.
    - If the user is NOT in a honeypot, returns a 404 so the orchestrator can
      pass the request to the real booking service.
    """
    if not honeypot.is_in_honeypot(req.user_id):
        raise HTTPException(
            status_code=404,
            detail=f"User {req.user_id} has no active honeypot session. Route to real booking service.",
        )

    result = honeypot.confirm(req.user_id)

    logger.info(
        "🍯 Confirm  user=%s  count=%d  confirmed_bot=%s",
        req.user_id, result["confirm_count"], result["confirmed_bot"],
    )

    return {
        "request_id": req.request_id,
        "user_id": req.user_id,
        **result,
        "timestamp": time.time(),
    }


@app.get("/stats", summary="Live scoring statistics")
async def get_stats() -> dict[str, Any]:
    """Return live counters for the dashboard."""
    return {
        "total_scored": _stats["total_scored"],
        "bots": _stats["bots"],
        "humans": _stats["humans"],
        "slow_queue": _stats["slow_queue"],
        "honeypot_active": honeypot.active_count(),
        "confirmed_bots": honeypot.confirmed_bot_count(),
        "blacklisted": blacklist.count(),
        "timestamp": time.time(),
    }


@app.get("/blacklist", summary="List confirmed bot user_ids")
async def get_blacklist() -> dict[str, Any]:
    """Return all user_ids that have been permanently blacklisted."""
    entries = blacklist.all_entries()
    return {
        "count": len(entries),
        "user_ids": entries,
        "timestamp": time.time(),
    }


@app.delete("/reset", summary="Reset all in-memory state (demo use only)")
async def reset_state() -> dict[str, str]:
    """Wipe all sessions, blacklist entries, and counters. Useful for demo resets."""
    honeypot.clear()
    blacklist.clear()
    _stats.update({"total_scored": 0, "bots": 0, "humans": 0, "slow_queue": 0})
    logger.info("🔄 Full state reset triggered")
    return {"status": "ok", "message": "All state cleared."}


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/", include_in_schema=False)
async def root() -> dict[str, str]:
    return {
        "service": "Smart Tatkal Guardian — Scoring Engine",
        "version": "1.0.0",
        "status": "running",
        "docs": "/docs",
    }
