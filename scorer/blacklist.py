"""
blacklist.py — In-memory blacklist of confirmed bot user_ids.
Thread-safe via a plain set (FastAPI runs single-threaded async).
"""

_blacklist: set[str] = set()


def add(user_id: str) -> None:
    _blacklist.add(user_id)


def is_blacklisted(user_id: str) -> bool:
    return user_id in _blacklist


def all_entries() -> list[str]:
    return sorted(_blacklist)


def clear() -> None:
    _blacklist.clear()


def count() -> int:
    return len(_blacklist)
