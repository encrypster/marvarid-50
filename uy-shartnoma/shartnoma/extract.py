"""Fayldan shartnoma mazmunini olish."""

from __future__ import annotations

import io
from dataclasses import dataclass

# Sahifasiga shundan kam belgi chiqsa, PDF skanerlangan deb hisoblanadi.
MIN_CHARS_PER_PAGE = 200
MAX_FILE_BYTES = 20 * 1024 * 1024
IMAGE_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


class UnsupportedFile(ValueError):
    """Fayl turi qoʻllab-quvvatlanmaydi yoki oʻqib boʻlmadi."""


@dataclass(frozen=True)
class Document:
    """Shartnoma: yo matn, yo modelga toʻgʻridan-toʻgʻri yuboriladigan fayl."""

    text: str | None = None
    binary: bytes | None = None
    media_type: str | None = None

    @property
    def is_text(self) -> bool:
        return self.text is not None


def _suffix(filename: str) -> str:
    return "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def _pdf_text(data: bytes) -> tuple[str, int]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n\n".join(pages).strip(), len(pages)


def _docx_text(data: bytes) -> str:
    from docx import Document as DocxDocument

    doc = DocxDocument(io.BytesIO(data))
    parts = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            parts.append(" | ".join(cell.text for cell in row.cells))
    return "\n".join(parts).strip()


def load_document(filename: str, data: bytes) -> Document:
    if len(data) > MAX_FILE_BYTES:
        raise UnsupportedFile("Fayl 20 MB dan katta")
    suffix = _suffix(filename)

    if suffix in IMAGE_TYPES:
        return Document(binary=data, media_type=IMAGE_TYPES[suffix])

    if suffix == ".pdf":
        try:
            text, pages = _pdf_text(data)
        except Exception as exc:
            raise UnsupportedFile(f"PDF oʻqilmadi: {exc}") from exc
        if pages and len(text) >= MIN_CHARS_PER_PAGE * pages:
            return Document(text=text)
        # Skanerlangan PDF: matn qatlami yoʻq, model sahifalarni oʻzi oʻqiydi.
        return Document(binary=data, media_type="application/pdf")

    if suffix == ".docx":
        try:
            text = _docx_text(data)
        except Exception as exc:
            raise UnsupportedFile(f"DOCX oʻqilmadi: {exc}") from exc
    elif suffix in (".txt", ".md"):
        text = data.decode("utf-8", errors="replace").strip()
    else:
        raise UnsupportedFile(
            "Qoʻllab-quvvatlanadigan turlar: PDF, DOCX, TXT, JPG, PNG, WEBP"
        )

    if not text:
        raise UnsupportedFile("Faylda matn topilmadi")
    return Document(text=text)
