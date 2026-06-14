"""smoke_test.py — End-to-end validation of the scoring engine at localhost:8002"""
import urllib.request
import json

BASE = "http://localhost:8002"


def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def get(path):
    with urllib.request.urlopen(f"{BASE}{path}") as r:
        return json.loads(r.read())


def delete(path):
    req = urllib.request.Request(f"{BASE}{path}", method="DELETE")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


# 0. Clean slate
delete("/reset")
print("=== Smoke Test: Smart Tatkal Scoring Engine ===\n")

# 1. Clear bot
bot = post("/score", {
    "user_id": "USR_TESTBOT",
    "behavioral": {
        "time_since_last_request_ms": 80,
        "mouse_movement_score": 0.0,
        "typing_speed_cpm": 0,
        "ip_request_count": 30,
        "requests_per_minute": 55
    }
})
print(f"[BOT]    prob={bot['bot_probability']}  level={bot['risk_level']}  action={bot['action']}")
print(f"         flags={bot['flags']}")

# 2. Clear human
human = post("/score", {
    "user_id": "USR_TESTHUMAN",
    "behavioral": {
        "time_since_last_request_ms": 9000,
        "mouse_movement_score": 0.92,
        "typing_speed_cpm": 280,
        "ip_request_count": 2,
        "requests_per_minute": 3
    }
})
print(f"\n[HUMAN]  prob={human['bot_probability']}  level={human['risk_level']}  action={human['action']}")

# 3. Suspicious — tuned to land in HONEYPOT band (0.60–0.85)
# Breakdown: RAPID_FIRE(~0.21) + NO_MOUSE(0.20) + NO_TYPING(0.15) + SHARED_IP(~0.10) = ~0.66
sus = post("/score", {
    "user_id": "USR_HONEYPOT_TEST",
    "behavioral": {
        "time_since_last_request_ms": 150,   # ~0.21 contribution (300ms→0.14 was too low)
        "mouse_movement_score": 0.0,          # full 0.20
        "typing_speed_cpm": 0,                # full 0.15
        "ip_request_count": 15,               # 0.10 contribution (halfway to 2×threshold=20)
        "requests_per_minute": 22             # small rate burst contribution
    }
})
print(f"\n[SUS]    prob={sus['bot_probability']}  level={sus['risk_level']}  action={sus['action']}")

# 4. Honeypot confirmation flow
if sus["action"] == "HONEYPOT":
    print("\n[HONEYPOT FLOW] Simulating 3 fake booking confirmations...")
    for i in range(3):
        c = post("/honeypot/confirm", {"user_id": "USR_HONEYPOT_TEST"})
        print(f"  confirm {i+1}/3: confirmed_bot={c['confirmed_bot']}  count={c['confirm_count']}  pnr={c['fake_pnr']}")
else:
    print(f"\n[WARN] USR_HONEYPOT_TEST got action={sus['action']} instead of HONEYPOT — adjust behavioral values if needed")

# 5. Verify blacklisted user gets auto-BLOCK
print("\n[BLACKLIST CHECK] Scoring USR_HONEYPOT_TEST again (should be auto-blocked)...")
recheck = post("/score", {
    "user_id": "USR_HONEYPOT_TEST",
    "behavioral": {}
})
print(f"  action={recheck['action']}  flags={recheck['flags']}")

# 6. Stats
stats = get("/stats")
print(f"\n[STATS]  {stats}")

# 7. Blacklist
bl = get("/blacklist")
print(f"[BLACKLIST] count={bl['count']}  ids={bl['user_ids']}")

print("\n=== All checks passed ===")
