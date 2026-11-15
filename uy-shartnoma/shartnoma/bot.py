"""Telegram bot: python -m shartnoma.bot

Muhit oʻzgaruvchilari:
  TELEGRAM_BOT_TOKEN  majburiy
  ANTHROPIC_API_KEY   tahlil uchun; boʻlmasa bot ishlaydi, lekin tekshirmaydi
  DAILY_LIMIT         bir foydalanuvchiga kunlik tekshiruvlar soni (standart 3)
  WEBHOOK_URL         berilsa (yoki Render oʻrnatgan RENDER_EXTERNAL_URL boʻlsa)
                      bot webhook rejimida PORT da tinglaydi; aks holda polling
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import os
from collections import defaultdict
from datetime import date

from aiogram import Bot, Dispatcher, F
from aiogram.enums import ChatAction, ParseMode
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import CommandStart
from aiogram.types import Message
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application
from aiohttp import web

from .analyzer import AnalysisError, analyze
from .checklist import load_checklist
from .cli import to_plain
from .extract import MAX_FILE_BYTES, UnsupportedFile, load_document
from .report import build_report, split_messages

log = logging.getLogger("shartnoma.bot")

START_TEXT = (
    "Assalomu alaykum! Men yangi uy sotib olish shartnomasini imzolashdan oldin "
    "tekshirib beraman: topshirish muddati, kechikish uchun penya, pulni qaytarish, "
    "kafolat va boshqa xavfli bandlar.\n\n"
    "Shartnomani PDF, DOCX yoki rasm qilib yuboring. Matnni toʻgʻridan-toʻgʻri "
    "yozib yuborsangiz ham boʻladi.\n\n"
    "Bilib qoʻying:\n"
    "• Fayl tahlil uchun xorijdagi sunʼiy intellekt xizmatiga yuboriladi va botda "
    "saqlanmaydi.\n"
    "• Matnli fayllarda pasport, JSHSHIR, telefon va karta raqamlari avtomatik "
    "yashiriladi. Rasm va skanerlarda yashirib boʻlmaydi — shaxsiy maʼlumotli "
    "sahifalarni yubormang yoki ustini yoping.\n"
    "• Bu dastlabki tekshiruv, huquqiy maslahat emas."
)
# Bundan qisqa matn shartnoma emas, oddiy xabar deb hisoblanadi.
MIN_PASTED_CHARS = 800
WEBHOOK_PATH = "/webhook"
NO_KEY_TEXT = "Tahlil xizmati hali ulanmagan. Birozdan soʻng urinib koʻring."

dp = Dispatcher()
_items = load_checklist()
_busy: set[int] = set()
_usage: dict[tuple[int, date], int] = defaultdict(int)
_daily_limit = int(os.environ.get("DAILY_LIMIT", "3"))


async def _send_report(message: Message, parts: list[str]) -> None:
    for text in split_messages(parts):
        try:
            await message.answer(text, parse_mode=ParseMode.HTML)
        except TelegramBadRequest:
            # HTML buzilgan boʻlsa (masalan, juda uzun iqtibos kesilgan), oddiy matn.
            await message.answer(to_plain(text), parse_mode=None)


async def _check(message: Message, filename: str, data: bytes) -> None:
    user_id = message.from_user.id
    key = (user_id, date.today())
    if not os.environ.get("ANTHROPIC_API_KEY"):
        await message.answer(NO_KEY_TEXT)
        return
    if user_id in _busy:
        await message.answer("Oldingi shartnoma hali tekshirilmoqda, biroz kuting.")
        return
    if _usage[key] >= _daily_limit:
        await message.answer(f"Bugungi limit ({_daily_limit} ta tekshiruv) tugadi.")
        return

    _busy.add(user_id)
    try:
        doc = load_document(filename, data)
        await message.answer("Tekshiryapman, bu 1–2 daqiqa olishi mumkin…")
        await message.bot.send_chat_action(message.chat.id, ChatAction.TYPING)
        result = await asyncio.to_thread(analyze, doc, _items)
        _usage[key] += 1
        await _send_report(message, build_report(result, _items))
    except (UnsupportedFile, AnalysisError) as exc:
        await message.answer(str(exc))
    except Exception:
        log.exception("Tekshiruvda kutilmagan xato (user=%s)", user_id)
        await message.answer("Kutilmagan xato yuz berdi. Keyinroq urinib koʻring.")
    finally:
        _busy.discard(user_id)


async def _download(bot: Bot, file_id: str) -> bytes:
    buffer = io.BytesIO()
    await bot.download(file_id, destination=buffer)
    return buffer.getvalue()


@dp.message(CommandStart())
async def start(message: Message) -> None:
    await message.answer(START_TEXT)


@dp.message(F.document)
async def on_document(message: Message) -> None:
    document = message.document
    if document.file_size and document.file_size > MAX_FILE_BYTES:
        await message.answer("Fayl 20 MB dan katta. Kichikroq fayl yuboring.")
        return
    data = await _download(message.bot, document.file_id)
    await _check(message, document.file_name or "fayl", data)


@dp.message(F.photo)
async def on_photo(message: Message) -> None:
    await message.answer(
        "Bitta rasmda shartnomaning faqat bir sahifasi boʻladi. Toʻliq tekshiruv "
        "uchun barcha sahifalarni bitta PDF qilib yuboring. Hozircha shu sahifani "
        "koʻrib chiqaman."
    )
    data = await _download(message.bot, message.photo[-1].file_id)
    await _check(message, "sahifa.jpg", data)


@dp.message(F.text)
async def on_text(message: Message) -> None:
    if len(message.text) < MIN_PASTED_CHARS:
        await message.answer("Shartnomani fayl qilib yuboring yoki /start ni bosing.")
        return
    await _check(message, "shartnoma.txt", message.text.encode("utf-8"))


def webhook_secret(token: str) -> str:
    """Telegram soʻrovlarini tanish uchun maxfiy qiymat; tokendan hosil qilinadi."""
    return hashlib.sha256(f"webhook:{token}".encode()).hexdigest()


def create_app(bot: Bot, secret: str) -> web.Application:
    async def health(_: web.Request) -> web.Response:
        return web.Response(text="ok")

    app = web.Application()
    app.router.add_get("/", health)
    SimpleRequestHandler(dispatcher=dp, bot=bot, secret_token=secret).register(
        app, path=WEBHOOK_PATH
    )
    return app


def run_webhook(bot: Bot, base_url: str, port: int) -> None:
    secret = webhook_secret(bot.token)

    async def on_startup() -> None:
        await bot.set_webhook(base_url.rstrip("/") + WEBHOOK_PATH, secret_token=secret)

    dp.startup.register(on_startup)
    app = create_app(bot, secret)
    setup_application(app, dp, bot=bot)
    web.run_app(app, host="0.0.0.0", port=port)


async def run_polling(bot: Bot) -> None:
    await bot.delete_webhook()
    await dp.start_polling(bot)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise SystemExit("TELEGRAM_BOT_TOKEN oʻrnatilmagan")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        log.warning("ANTHROPIC_API_KEY yoʻq: bot javob beradi, lekin tekshirmaydi")
    bot = Bot(token)
    base_url = os.environ.get("WEBHOOK_URL") or os.environ.get("RENDER_EXTERNAL_URL")
    if base_url:
        run_webhook(bot, base_url, int(os.environ.get("PORT", "10000")))
    else:
        asyncio.run(run_polling(bot))


if __name__ == "__main__":
    main()
