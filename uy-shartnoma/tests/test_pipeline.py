from pathlib import Path
from types import SimpleNamespace

import pytest

from shartnoma.analyzer import (
    Analysis,
    AnalysisError,
    Finding,
    OtherRisk,
    analyze,
    quote_in_text,
)
from shartnoma.checklist import load_checklist
from shartnoma.cli import to_plain
from shartnoma.extract import Document, UnsupportedFile, load_document
from shartnoma.redact import redact
from shartnoma.report import build_report, split_messages

SAMPLE = Path(__file__).resolve().parent.parent / "samples" / "namuna_shartnoma.txt"
ITEMS = load_checklist()


class FakeClient:
    """anthropic.Anthropic oʻrnida: berilgan tahlilni qaytaradi va soʻrovni eslab qoladi."""

    def __init__(self, analysis, stop_reason="end_turn"):
        self.kwargs = None
        response = SimpleNamespace(stop_reason=stop_reason, parsed_output=analysis)

        def parse(**kwargs):
            self.kwargs = kwargs
            return response

        self.beta = SimpleNamespace(messages=SimpleNamespace(parse=parse))


def full_analysis(**overrides):
    findings = [
        Finding(check_id=i.id, status="joyida", quote="", explanation="Joyida.")
        for i in ITEMS
    ]
    data = dict(
        is_housing_contract=True,
        contract_language="uz",
        summary="Qisqa xulosa.",
        findings=findings,
        other_risks=[],
    )
    data.update(overrides)
    return Analysis(**data)


def test_checklist_is_consistent():
    assert len(ITEMS) >= 10
    assert all(not i.legal_verified for i in ITEMS)


def test_redact_hides_personal_data():
    text, counts = redact(SAMPLE.read_text(encoding="utf-8"))
    for secret in ("AB1234567", "12345678901234", "123 45 67"):
        assert secret not in text
    assert counts == {"[JSHSHIR]": 1, "[TELEFON]": 1, "[PASPORT]": 1}
    # Narx va maydon kabi raqamlar oʻzgarmasligi kerak.
    assert "717 600 000 soʻm" in text and "62,4 kv.m" in text


def test_redact_card_and_account():
    text, counts = redact("Karta 8600 1234 5678 9012, h/r 20208000900123456001.")
    assert "8600" not in text and "20208000900123456001" not in text
    assert counts == {"[KARTA]": 1, "[HISOBRAQAM]": 1}


def test_quote_matching_ignores_spacing_and_apostrophes():
    text = "Quruvchi   narxni bir tomonlama\ntartibda qayta ko‘rib chiqishga haqli."
    assert quote_in_text("narxni bir tomonlama tartibda qayta koʻrib chiqishga haqli", text)
    assert not quote_in_text("narxni xaridor roziligi bilan oʻzgartiradi", text)
    assert not quote_in_text("", text)


def test_load_document_types():
    assert load_document("a.txt", "Matn".encode()).text == "Matn"
    image = load_document("sahifa.JPG", b"\xff\xd8")
    assert not image.is_text and image.media_type == "image/jpeg"
    with pytest.raises(UnsupportedFile):
        load_document("a.xlsx", b"x")
    with pytest.raises(UnsupportedFile):
        load_document("a.txt", b"   ")


def test_analyze_sends_redacted_text_and_flags_bad_quotes():
    doc = load_document(SAMPLE.name, SAMPLE.read_bytes())
    analysis = full_analysis()
    analysis.findings[0] = Finding(
        check_id=ITEMS[0].id,
        status="muammo",
        quote="taxminan 2027-yilning toʻrtinchi choragida foydalanishga",
        explanation="Aniq sana yoʻq.",
    )
    analysis.findings[1] = Finding(
        check_id=ITEMS[1].id,
        status="muammo",
        quote="Quruvchi hech qanday javobgar emas",  # shartnomada yoʻq
        explanation="Toʻqilgan iqtibos.",
    )
    analysis.findings.append(
        Finding(check_id="nomalum_band", status="muammo", quote="", explanation="x")
    )
    analysis.other_risks = [
        OtherRisk(quote="xonadon sifati yuzasidan daʼvo qilishga haqli emas", explanation="x")
    ]
    client = FakeClient(analysis)

    result = analyze(doc, ITEMS, client=client)

    sent = client.kwargs["messages"][0]["content"][0]["text"]
    assert "AB1234567" not in sent and "[PASPORT]" in sent
    assert client.kwargs["model"] == "claude-opus-5-5"
    assert ITEMS[0].id in client.kwargs["system"][0]["text"]
    assert result.unverified_quotes == {ITEMS[1].id}
    assert all(f.check_id != "nomalum_band" for f in result.analysis.findings)
    assert result.missing_checks == []


def test_analyze_reports_missing_checks_and_binary_input():
    analysis = full_analysis()
    dropped = analysis.findings.pop()
    client = FakeClient(analysis)
    doc = Document(binary=b"%PDF-1.4", media_type="application/pdf")

    result = analyze(doc, ITEMS, client=client)

    block = client.kwargs["messages"][0]["content"][0]
    assert block["type"] == "document" and block["source"]["media_type"] == "application/pdf"
    assert result.missing_checks == [dropped.check_id]
    assert not result.quotes_checkable


@pytest.mark.parametrize("stop_reason", ["refusal", "max_tokens"])
def test_analyze_raises_on_incomplete_response(stop_reason):
    client = FakeClient(full_analysis(), stop_reason=stop_reason)
    with pytest.raises(AnalysisError):
        analyze(Document(text="Shartnoma matni"), ITEMS, client=client)


def test_report_groups_findings_and_escapes_html():
    analysis = full_analysis()
    analysis.findings[0] = Finding(
        check_id=ITEMS[0].id,
        status="muammo",
        quote="muddat <taxminan> belgilanadi",
        explanation="Aniq sana yoʻq.",
    )
    analysis.findings[1] = Finding(
        check_id=ITEMS[1].id, status="yoq", quote="", explanation="Penya yozilmagan."
    )
    analysis.findings[2] = Finding(
        check_id=ITEMS[2].id, status="aniqlanmadi", quote="", explanation="Sahifa yoʻq."
    )
    client = FakeClient(analysis)
    result = analyze(Document(text="Boshqa matn"), ITEMS, client=client)

    text = "\n\n".join(build_report(result, ITEMS))

    assert "Muammoli bandlar: 2 · Aniqlanmadi: 1" in text
    assert "&lt;taxminan&gt;" in text and "<taxminan>" not in text
    assert "iqtibos matndan topilmadi" in text
    assert "Shartnomada bu masala umuman yozilmagan." in text
    assert ITEMS[0].ask_developer in to_plain(text)
    assert "huquqiy maslahat emas" in text


def test_report_for_non_contract():
    analysis = full_analysis(is_housing_contract=False, findings=[], summary="Bu ijara shartnomasi.")
    result = analyze(Document(text="Ijara"), ITEMS, client=FakeClient(analysis))
    parts = build_report(result, ITEMS)
    assert "oʻxshamaydi" in parts[0] and len(parts) == 2


def test_split_messages_respects_limit():
    parts = ["a" * 30, "b" * 30, "\n".join(["c" * 20] * 5)]
    messages = split_messages(parts, limit=50)
    assert all(len(m) <= 50 for m in messages)
    assert "".join(messages).count("c") == 100
