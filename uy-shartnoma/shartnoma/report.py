"""Tahlil natijasini foydalanuvchiga koʻrsatiladigan matnga aylantirish."""

from __future__ import annotations

from html import escape

from .analyzer import Result
from .checklist import CheckItem

TELEGRAM_LIMIT = 4096
_SEVERITY_ORDER = {"yuqori": 0, "orta": 1, "past": 2}
_SEVERITY_LABEL = {"yuqori": "yuqori xavf", "orta": "oʻrta xavf", "past": "past xavf"}

DISCLAIMER = (
    "Bu dastlabki avtomatik tekshiruv, huquqiy maslahat emas. "
    "Imzolashdan oldin shartnomani yuristga koʻrsating."
)
UNVERIFIED_NOTE = "⚠️ Bu iqtibos matndan topilmadi — bandni shartnomadan oʻzingiz tekshiring."


def _quote(text: str) -> str:
    return f"<blockquote>{escape(text)}</blockquote>"


def build_report(result: Result, items: list[CheckItem]) -> list[str]:
    """Hisobot boʻlimlari roʻyxati (Telegram HTML). Har biri alohida abzas."""
    analysis = result.analysis
    if not analysis.is_housing_contract:
        return [
            "Bu hujjat uy-joy sotib olish shartnomasiga oʻxshamaydi.",
            escape(analysis.summary),
        ]

    by_id = {item.id: item for item in items}
    findings = sorted(
        analysis.findings, key=lambda f: _SEVERITY_ORDER[by_id[f.check_id].severity]
    )
    bad = [f for f in findings if f.status in ("muammo", "yoq")]
    unclear = [f for f in findings if f.status == "aniqlanmadi"]
    good = [f for f in findings if f.status == "joyida"]

    parts = [
        "<b>Shartnoma tekshiruvi</b>\n"
        f"Muammoli bandlar: {len(bad)} · Aniqlanmadi: {len(unclear)} · Joyida: {len(good)}",
        escape(analysis.summary),
    ]

    for f in bad:
        item = by_id[f.check_id]
        head = "🔴" if item.severity == "yuqori" else "🟠"
        lines = [f"{head} <b>{escape(item.title)}</b> ({_SEVERITY_LABEL[item.severity]})"]
        if f.status == "yoq":
            lines.append("Shartnomada bu masala umuman yozilmagan.")
        if f.quote:
            lines.append(_quote(f.quote))
            if f.check_id in result.unverified_quotes:
                lines.append(UNVERIFIED_NOTE)
        lines.append(escape(f.explanation))
        lines.append(f"<i>Nega muhim:</i> {escape(item.why)}")
        lines.append(f"<i>Quruvchidan soʻrang:</i> {escape(item.ask_developer)}")
        parts.append("\n".join(lines))

    for n, risk in enumerate(analysis.other_risks):
        lines = ["🟠 <b>Qoʻshimcha xavfli band</b>", _quote(risk.quote)]
        if f"other:{n}" in result.unverified_quotes:
            lines.append(UNVERIFIED_NOTE)
        lines.append(escape(risk.explanation))
        parts.append("\n".join(lines))

    if unclear or result.missing_checks:
        lines = ["⚪ <b>Aniqlab boʻlmadi — oʻzingiz tekshiring</b>"]
        for f in unclear:
            lines.append(f"• {escape(by_id[f.check_id].title)}: {escape(f.explanation)}")
        for check_id in result.missing_checks:
            lines.append(f"• {escape(by_id[check_id].title)}: tahlilda xulosa chiqmadi.")
        parts.append("\n".join(lines))

    if good:
        lines = ["✅ <b>Joyida</b>"]
        lines += [f"• {escape(by_id[f.check_id].title)}" for f in good]
        parts.append("\n".join(lines))

    notes = []
    if not result.quotes_checkable:
        notes.append(
            "Fayl rasm yoki skaner boʻlgani uchun iqtiboslar avtomatik tekshirilmadi."
        )
    if result.redactions:
        hidden = sum(result.redactions.values())
        notes.append(f"Tahlildan oldin {hidden} ta shaxsiy maʼlumot yashirildi.")
    notes.append(DISCLAIMER)
    parts.append("\n".join(notes))
    return parts


def split_messages(parts: list[str], limit: int = TELEGRAM_LIMIT) -> list[str]:
    """Boʻlimlarni Telegram chegarasiga sigʻadigan xabarlarga yigʻadi."""
    messages: list[str] = []
    current = ""
    for part in parts:
        # Bitta boʻlim chegaradan oshsa, teglarni buzmaslik uchun qatorlar boʻyicha boʻlinadi.
        chunks = [part] if len(part) <= limit else _split_long(part, limit)
        for chunk in chunks:
            candidate = f"{current}\n\n{chunk}" if current else chunk
            if len(candidate) <= limit:
                current = candidate
            else:
                messages.append(current)
                current = chunk
    if current:
        messages.append(current)
    return messages


def _split_long(part: str, limit: int) -> list[str]:
    chunks: list[str] = []
    current = ""
    for line in part.split("\n"):
        line = line[:limit]
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) <= limit:
            current = candidate
        else:
            chunks.append(current)
            current = line
    if current:
        chunks.append(current)
    return chunks
