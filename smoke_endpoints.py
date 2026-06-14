import urllib.request, json

BASE = "http://localhost:8002"

def post(path, data):
    req = urllib.request.Request(
        f"{BASE}{path}",
        json.dumps(data).encode(),
        {"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req).read())

def get(path):
    return json.loads(urllib.request.urlopen(f"{BASE}{path}").read())

def delete(path):
    req = urllib.request.Request(f"{BASE}{path}", method="DELETE")
    return json.loads(urllib.request.urlopen(req).read())

# 1. Score a clear bot
print("=== BOT SCORE ===")
r = post("/score", {
    "user_id": "USR_BOT1",
    "behavioral": {
        "time_since_last_request_ms": 100,
        "mouse_movement_score": 0.01,
        "typing_speed_cpm": 0,
        "ip_request_count": 50,
        "requests_per_minute": 60,
    },
})
print(f"  prob={r['bot_probability']}  level={r['risk_level']}  action={r['action']}  flags={r['flags']}")
assert r["action"] in ("HONEYPOT", "BLOCK"), f"Expected HONEYPOT/BLOCK, got {r['action']}"

# 2. Score a clear human
print("=== HUMAN SCORE ===")
r2 = post("/score", {
    "user_id": "USR_HUM1",
    "behavioral": {
        "time_since_last_request_ms": 3000,
        "mouse_movement_score": 0.9,
        "typing_speed_cpm": 220,
        "ip_request_count": 2,
        "requests_per_minute": 3,
    },
})
print(f"  prob={r2['bot_probability']}  level={r2['risk_level']}  action={r2['action']}")
assert r2["action"] == "ALLOW", f"Expected ALLOW, got {r2['action']}"

# 3. Honeypot pipeline: score into honeypot, then confirm 3x
print("=== HONEYPOT CONFIRMS ===")
BOT = "USR_HPOT1"
score_r = post("/score", {
    "user_id": BOT,
    "behavioral": {
        "time_since_last_request_ms": 200,
        "mouse_movement_score": 0.05,
        "typing_speed_cpm": 0,
        "ip_request_count": 15,
        "requests_per_minute": 25,
    },
})
print(f"  scored: prob={score_r['bot_probability']}  action={score_r['action']}")

for i in range(3):
    r3 = post("/honeypot/confirm", {"user_id": BOT})
    print(f"  confirm #{i+1}: count={r3['confirm_count']}  confirmed_bot={r3['confirmed_bot']}")

assert r3["confirmed_bot"] is True, "Should be CONFIRMED_BOT after 3 confirmations"

# 4. Stats
print("=== STATS ===")
s = get("/stats")
print(f"  {s}")
assert s["confirmed_bots"] >= 1

# 5. Blacklist
print("=== BLACKLIST ===")
bl = get("/blacklist")
print(f"  {bl}")
assert BOT in bl["user_ids"]

# 6. Reset
print("=== RESET ===")
rs = delete("/reset")
print(f"  {rs}")
s2 = get("/stats")
assert s2["total_scored"] == 0

print("\n✅  ALL TESTS PASSED")
