"""
honeypot.py — Honeypot session tracking.

When the scoring engine decides action = HONEYPOT:
  1. user_id is stored in honeypot_sessions with a fake PNR.
  2. When that user calls /honeypot/confirm they receive a convincing
     "Booking Confirmed" response — but nothing real was booked.
  3. After CONFIRM_THRESHOLD fake confirmations the user is marked
     CONFIRMED_BOT and added to the blacklist.

Bots confirm blindly because they never verify the PNR is real.
Humans quickly notice that the PNR doesn't exist.
"""

from __future__ import annotations

import logging
import random
import string
import time
from dataclasses import dataclass, field
from typing import Optional

import blacklist

logger = logging.getLogger(__name__)

# How many honeypot confirmations before we're sure it's a bot
CONFIRM_THRESHOLD = 3


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

@dataclass
class HoneypotSession:
    user_id: str
    fake_pnr: str
    created_at: float = field(default_factory=time.time)
    confirm_count: int = 0
    confirmed_bot: bool = False


# In-memory store: user_id → HoneypotSession
_sessions: dict[str, HoneypotSession] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _generate_fake_pnr() -> str:
    """Produce a realistic-looking but entirely fake PNR."""
    prefix = random.choice(["PNR", "TKL", "IRK"])
    digits = "".join(random.choices(string.digits, k=10))
    return f"{prefix}{digits}"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def activate(user_id: str) -> str:
    """
    Place user_id into a honeypot session and return the fake PNR
    that the orchestrator should serve back to the client.
    """
    if user_id not in _sessions:
        session = HoneypotSession(
            user_id=user_id,
            fake_pnr=_generate_fake_pnr(),
        )
        _sessions[user_id] = session
        logger.info("🍯 Honeypot activated for %s  fake_pnr=%s", user_id, session.fake_pnr)
    return _sessions[user_id].fake_pnr


def is_in_honeypot(user_id: str) -> bool:
    return user_id in _sessions


def confirm(user_id: str) -> dict:
    """
    Called when a user (believed to be in a honeypot) tries to confirm a booking.
    Returns a convincing-but-fake confirmation dict.
    After CONFIRM_THRESHOLD hits, escalates to CONFIRMED_BOT + blacklist.
    """
    if user_id not in _sessions:
        # Not a honeypot user — let the orchestrator handle normally
        return {"honeypot": False}

    session = _sessions[user_id]
    session.confirm_count += 1

    logger.warning(
        "🍯 Honeypot confirm attempt  user=%s  count=%d/%d  pnr=%s",
        user_id, session.confirm_count, CONFIRM_THRESHOLD, session.fake_pnr,
    )

    if session.confirm_count >= CONFIRM_THRESHOLD and not session.confirmed_bot:
        session.confirmed_bot = True
        blacklist.add(user_id)
        logger.critical(
            "🚨 CONFIRMED_BOT  user=%s  added to blacklist (fake confirmations=%d)",
            user_id, session.confirm_count,
        )

    return {
        "honeypot": True,
        "fake_pnr": session.fake_pnr,
        "confirm_count": session.confirm_count,
        "confirmed_bot": session.confirmed_bot,
        # Realistic-looking fake payload the bot will swallow whole
        "booking_status": "CONFIRMED",
        "pnr": session.fake_pnr,
        "train": "12951 RAJDHANI EXP",
        "departure": "2026-06-15T06:00:00",
        "coach": f"B{random.randint(1,9)}",
        "seat": f"{random.randint(1,72)}",
        "message": "Your Tatkal ticket has been successfully booked.",
    }


def active_count() -> int:
    return len(_sessions)


def confirmed_bot_count() -> int:
    return sum(1 for s in _sessions.values() if s.confirmed_bot)


def clear() -> None:
    _sessions.clear()
    logger.info("🍯 All honeypot sessions cleared")
