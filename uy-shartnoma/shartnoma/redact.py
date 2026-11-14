"""Matnni tashqi xizmatga yuborishdan oldin shaxsiy maʼlumotlarni yashirish.

Faqat matnli hujjatlarga ishlaydi. Rasm va skanerlangan PDF yashirilmasdan
yuboriladi, shuning uchun bot bunday fayllar uchun alohida ogohlantiradi.
"""

from __future__ import annotations

import re

# Tartib muhim: uzun raqamli naqshlar qisqalaridan oldin tekshiriladi.
_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("[KARTA]", re.compile(r"(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?!\d)")),
    ("[HISOBRAQAM]", re.compile(r"(?<!\d)\d{20}(?!\d)")),
    ("[JSHSHIR]", re.compile(r"(?<!\d)\d{14}(?!\d)")),
    ("[TELEFON]", re.compile(r"(?<!\d)\+?998[ \-(]*\d{2}[ \-)]*\d{3}[ -]?\d{2}[ -]?\d{2}(?!\d)")),
    ("[PASPORT]", re.compile(r"(?<![A-Za-zА-Яа-я])[A-ZА-Я]{2}\s?\d{7}(?!\d)")),
    ("[EMAIL]", re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")),
]


def redact(text: str) -> tuple[str, dict[str, int]]:
    """Yashirilgan matn va har bir tur boʻyicha almashtirishlar sonini qaytaradi."""
    counts: dict[str, int] = {}
    for label, pattern in _PATTERNS:
        text, n = pattern.subn(label, text)
        if n:
            counts[label] = n
    return text, counts
