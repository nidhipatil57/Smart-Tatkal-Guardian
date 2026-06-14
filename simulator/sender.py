import copy
import httpx

# Send full profile to orchestrator /ingest.
# Orchestrator does scoring internally AND broadcasts via WebSocket to the dashboard.
ORCHESTRATOR_URL = "http://localhost:8000/ingest"


async def send_request(request_dict: dict) -> dict | None:
    """Strip is_bot field and POST the full profile to the orchestrator /ingest.
    
    Creates a fresh httpx client each call to avoid stale connection pools
    when the orchestrator restarts mid-session.
    """
    payload = copy.deepcopy(request_dict)
    payload.pop("is_bot", None)  # NEVER expose ground-truth label to scoring service

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.post(ORCHESTRATOR_URL, json=payload)
        if response.status_code in (200, 201):
            return response.json()      # event dict for WebSocket broadcast
        print(f"[sender] Orchestrator returned {response.status_code}: {response.text[:100]}")
        return None
    except (httpx.ConnectError, httpx.TimeoutException):
        print(f"[sender] Orchestrator offline — dropping request")
        return None
    except Exception as e:
        print(f"[sender] Unexpected error: {e}")
        return None
