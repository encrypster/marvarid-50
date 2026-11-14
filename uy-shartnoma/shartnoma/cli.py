"""Buyruq satridan tekshirish: python -m shartnoma.cli shartnoma.pdf"""

from __future__ import annotations

import argparse
import re
import sys
from html import unescape
from pathlib import Path

from .analyzer import AnalysisError, analyze
from .checklist import load_checklist
from .extract import UnsupportedFile, load_document
from .report import build_report


def to_plain(html: str) -> str:
    html = re.sub(r"</?blockquote>", '"', html)
    return unescape(re.sub(r"<[^>]+>", "", html))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Uy-joy shartnomasini tekshirish")
    parser.add_argument("file", type=Path, help="PDF, DOCX, TXT yoki rasm")
    args = parser.parse_args(argv)

    items = load_checklist()
    try:
        doc = load_document(args.file.name, args.file.read_bytes())
        result = analyze(doc, items)
    except (UnsupportedFile, AnalysisError, OSError) as exc:
        print(f"Xato: {exc}", file=sys.stderr)
        return 1

    print("\n\n".join(to_plain(part) for part in build_report(result, items)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
