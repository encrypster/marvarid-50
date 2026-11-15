"""Tekshiruv roʻyxatini yuklash."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "checklist.json"
SEVERITIES = ("yuqori", "orta", "past")


@dataclass(frozen=True)
class CheckItem:
    id: str
    title: str
    severity: str
    look_for: str
    why: str
    ask_developer: str
    stat: str
    source: str
    law_refs: list[str] = field(default_factory=list)
    absence_ok: bool = False


def load_checklist(path: Path = DEFAULT_PATH) -> list[CheckItem]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    items = [CheckItem(**item) for item in raw["items"]]
    ids = [item.id for item in items]
    if len(ids) != len(set(ids)):
        raise ValueError("Tekshiruv roʻyxatida takrorlangan id bor")
    for item in items:
        if item.severity not in SEVERITIES:
            raise ValueError(f"{item.id}: nomaʼlum severity {item.severity!r}")
    return items
