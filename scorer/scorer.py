"""
scorer.py — Weighted rule-based bot probability scorer.

Feature weights (tuned for Tatkal bot patterns):
  time_since_last_request_ms  <  500ms  → 0.30
  mouse_movement_score        < 0.2     → 0.20
  typing_speed_cpm            = 0       → 0.15
  ip_request_count            > 10      → 0.20
  requests_per_minute         > 20      → 0.15

Final score = weighted sum, clamped to [0.0, 1.0].

Risk levels:
  0.00 – 0.30  LOW       → ALLOW
  0.30 – 0.60  MEDIUM    → SLOW_QUEUE
  0.60 – 0.85  HIGH      → HONEYPOT
  0.85 – 1.00  CRITICAL  → BLOCK
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


# ---------------------------------------------------------------------------
# Thresholds & weights
# ---------------------------------------------------------------------------

WEIGHTS = {
    "time_since_last_request_ms": 0.30,
    "mouse_movement_score": 0.20,
    "typing_speed_cpm": 0.15,
    "ip_request_count": 0.20,
    "requests_per_minute": 0.15,
}

# Each entry: (threshold, is_bot_when_below)
#   is_bot_when_below=True  → score fires when value < threshold
#   is_bot_when_below=False → score fires when value > threshold
THRESHOLDS: dict[str, tuple[float, bool]] = {
    "time_since_last_request_ms": (500.0, True),   # rapid-fire < 500ms
    "mouse_movement_score": (0.2, True),            # frozen cursor < 0.2
    "typing_speed_cpm": (1.0, True),                # zero / near-zero typing
    "ip_request_count": (10.0, False),              # shared/hammered IP > 10
    "requests_per_minute": (20.0, False),           # rate burst > 20
}

RISK_TABLE = [
    (0.85, "CRITICAL", "BLOCK"),
    (0.60, "HIGH", "HONEYPOT"),
    (0.30, "MEDIUM", "SLOW_QUEUE"),
    (0.00, "LOW", "ALLOW"),
]

FLAG_MAP = {
    "time_since_last_request_ms": "RAPID_FIRE",
    "mouse_movement_score": "NO_MOUSE",
    "typing_speed_cpm": "NO_TYPING",
    "ip_request_count": "SHARED_IP",
    "requests_per_minute": "RATE_BURST",
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

@dataclass
class ScoreResult:
    bot_probability: float
    risk_level: str
    action: str
    flags: list[str]
    feature_scores: dict[str, float]          # per-feature contribution


def score(behavioral: dict[str, Any]) -> ScoreResult:
    """
    Compute a bot probability score from a behavioral feature dict.

    Expected keys (all optional — missing keys are treated conservatively):
        time_since_last_request_ms, mouse_movement_score, typing_speed_cpm,
        ip_request_count, requests_per_minute
    """
    total: float = 0.0
    flags: list[str] = []
    feature_scores: dict[str, float] = {}

    for feature, weight in WEIGHTS.items():
        threshold, bot_when_below = THRESHOLDS[feature]
        raw = behavioral.get(feature)

        if raw is None:
            # Missing feature → treat as fully bot-like for that dimension
            contribution = weight
            feature_scores[feature] = contribution
            flags.append(FLAG_MAP[feature])
            total += contribution
            continue

        value = float(raw)

        if bot_when_below:
            # Continuous penalty: full weight at 0, zero weight at threshold
            # Linearly interpolated so partial signals are captured.
            if value <= 0:
                ratio = 1.0
            elif value >= threshold:
                ratio = 0.0
            else:
                ratio = 1.0 - (value / threshold)
        else:
            # Continuous penalty: zero weight at threshold, full at 2× threshold
            if value <= threshold:
                ratio = 0.0
            elif value >= threshold * 2:
                ratio = 1.0
            else:
                ratio = (value - threshold) / threshold

        contribution = round(weight * ratio, 4)
        feature_scores[feature] = contribution

        if contribution > 0:
            flags.append(FLAG_MAP[feature])

        total += contribution

    # Clamp
    probability = round(min(max(total, 0.0), 1.0), 4)

    # Classify
    risk_level, action = _classify(probability)

    return ScoreResult(
        bot_probability=probability,
        risk_level=risk_level,
        action=action,
        flags=sorted(set(flags)),
        feature_scores=feature_scores,
    )


def _classify(probability: float) -> tuple[str, str]:
    for threshold, risk, action in RISK_TABLE:
        if probability >= threshold:
            return risk, action
    return "LOW", "ALLOW"   # fallback (should never reach here)
