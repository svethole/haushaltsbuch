#!/usr/bin/env python3
"""Haushaltsbuch – kleines Backend ohne Zusatzpakete.

Liefert die Weboberfläche aus ./static aus und stellt eine JSON-Schnittstelle
unter /api/ bereit. Die Daten liegen in einer SQLite-Datei.

Aufruf:
    python3 server.py                       # startet auf 127.0.0.1:8085
    python3 server.py --port 9000 --db /pfad/zur/haushaltsbuch.db
    python3 server.py --import datei.json   # Daten einspielen (ersetzt alles!)

Der Server lauscht absichtlich nur auf 127.0.0.1. Zugriffsschutz (Passwort)
und HTTPS übernimmt nginx davor.
"""

import argparse
import calendar
import json
import mimetypes
import os
import re
import sqlite3
import sys
import threading
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from email.message import EmailMessage
import smtplib
import ssl
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DB_PATH = BASE / "data" / "haushaltsbuch.db"
WRITE_LOCK = threading.Lock()
EXPORT_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS categories (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color   TEXT NOT NULL DEFAULT '#898781',
    icon    TEXT NOT NULL DEFAULT 'tag',
    archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS expenses (
    id          INTEGER PRIMARY KEY,
    date        TEXT NOT NULL,                -- JJJJ-MM-TT
    shop        TEXT NOT NULL,
    amount      INTEGER NOT NULL,             -- in Cent
    category_id INTEGER NOT NULL REFERENCES categories(id),
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE TABLE IF NOT EXISTS pots (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color    TEXT NOT NULL DEFAULT '#2a78d6',
    icon     TEXT NOT NULL DEFAULT 'piggy-bank',
    target   INTEGER,                         -- Sparziel in Cent (optional)
    note     TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pot_tx (
    id     INTEGER PRIMARY KEY,
    pot_id INTEGER NOT NULL REFERENCES pots(id) ON DELETE CASCADE,
    date   TEXT NOT NULL,
    amount INTEGER NOT NULL,                  -- Cent, positiv = Einzahlung
    note   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS recurring (
    id       INTEGER PRIMARY KEY,
    kind     TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    name     TEXT NOT NULL,
    amount   INTEGER NOT NULL,                -- Cent pro Fälligkeit
    interval INTEGER NOT NULL DEFAULT 1,      -- alle n Monate
    grp      TEXT NOT NULL DEFAULT '',        -- Gruppe, z.B. Wohnen, Verträge
    variable INTEGER NOT NULL DEFAULT 0,      -- Betrag schwankt (z.B. Gehalt)
    note     TEXT NOT NULL DEFAULT '',
    active   INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS subs (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    provider     TEXT NOT NULL DEFAULT 'other',  -- Schlüssel aus der Anbieterliste der Oberfläche
    url          TEXT NOT NULL DEFAULT '',       -- Seite zum Verwalten/Kündigen
    amount       INTEGER NOT NULL,               -- Cent pro Abbuchung
    interval     INTEGER NOT NULL DEFAULT 1,     -- alle n Monate
    next_due     TEXT NOT NULL,                  -- nächste Abbuchung (wird automatisch weitergezählt)
    note         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
    remind_mode  TEXT NOT NULL DEFAULT 'none' CHECK (remind_mode IN ('none', 'before', 'date')),
    remind_days  INTEGER NOT NULL DEFAULT 7,     -- bei 'before': Tage vor der Abbuchung
    remind_date  TEXT,                           -- bei 'date': fester Tag
    ch_page      INTEGER NOT NULL DEFAULT 1,     -- Hinweis auf der Seite
    ch_browser   INTEGER NOT NULL DEFAULT 0,     -- Browser-Benachrichtigung
    ch_email     INTEGER NOT NULL DEFAULT 0,     -- E-Mail
    ack_key      TEXT NOT NULL DEFAULT '',       -- welche Erinnerung schon erledigt ist
    snooze_until TEXT,                           -- später erinnern
    email_key    TEXT NOT NULL DEFAULT ''        -- welche Erinnerung schon gemailt wurde
);
CREATE TABLE IF NOT EXISTS pauses (               -- Zeiträume ohne Statistik (Urlaub …)
    id    INTEGER PRIMARY KEY,
    day_from TEXT NOT NULL,              -- erster Tag (JJJJ-MM-TT)
    day_to   TEXT NOT NULL,              -- letzter Tag, inklusive
    label TEXT NOT NULL DEFAULT ''       -- z. B. Urlaub
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- Datenbank

def connect():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


@contextmanager
def db():
    """Verbindung öffnen, bei Erfolg speichern, bei Fehler zurückrollen, immer schließen."""
    con = connect()
    try:
        with con:
            yield con
    finally:
        con.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.execute("PRAGMA journal_mode = WAL")
        con.executescript(SCHEMA)


def rows(con, sql, *args):
    return [dict(r) for r in con.execute(sql, args)]


def all_data(con):
    return {
        "categories": rows(con, "SELECT * FROM categories ORDER BY name"),
        "expenses": rows(con, "SELECT id, date, shop, amount, category_id, note FROM expenses ORDER BY date, id"),
        "pots": rows(con, "SELECT * FROM pots ORDER BY name"),
        "pot_tx": rows(con, "SELECT * FROM pot_tx ORDER BY date, id"),
        "recurring": rows(con, "SELECT * FROM recurring ORDER BY kind DESC, grp, name"),
        "subs": rows(con, "SELECT * FROM subs ORDER BY name"),
        "excluded": rows(con, "SELECT * FROM pauses ORDER BY day_from"),
        "settings": {
            "notify_email": get_setting(con, "notify_email", ""),
            "tracking_start": get_setting(con, "tracking_start", ""),
            "smtp_configured": smtp_config() is not None,
            "today": date.today().isoformat(),
        },
    }


def get_setting(con, key, default=None):
    row = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def set_setting(con, key, value):
    con.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


# ---------------------------------------------------------------- Prüfungen

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def v_date(value, field="Datum"):
    if not isinstance(value, str) or not DATE_RE.match(value):
        raise ApiError(400, f"{field}: ungültiges Datum")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ApiError(400, f"{field}: ungültiges Datum")
    return value


def v_text(value, field, required=True, max_len=200):
    value = (value or "").strip() if isinstance(value, (str, type(None))) else None
    if value is None:
        raise ApiError(400, f"{field}: Text erwartet")
    if required and not value:
        raise ApiError(400, f"{field} fehlt")
    return value[:max_len]


def v_cents(value, field="Betrag", allow_negative=False, allow_zero=False):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ApiError(400, f"{field}: ganze Zahl (Cent) erwartet")
    if value < 0 and not allow_negative:
        raise ApiError(400, f"{field} darf nicht negativ sein")
    if value == 0 and not allow_zero:
        raise ApiError(400, f"{field} darf nicht 0 sein")
    if abs(value) > 100_000_000:
        raise ApiError(400, f"{field} ist unplausibel hoch")
    return value


def v_color(value):
    if not isinstance(value, str) or not COLOR_RE.match(value):
        raise ApiError(400, "Farbe: Format #rrggbb erwartet")
    return value.lower()


def v_icon(value):
    if not isinstance(value, str) or not re.match(r"^[a-z0-9-]{1,40}$", value):
        raise ApiError(400, "Icon ungültig")
    return value


def need(con, table, id_):
    row = con.execute(f"SELECT * FROM {table} WHERE id = ?", (id_,)).fetchone()
    if not row:
        raise ApiError(404, "Eintrag nicht gefunden")
    return dict(row)


def unique_guard(fn):
    def wrapper(*a, **kw):
        try:
            return fn(*a, **kw)
        except sqlite3.IntegrityError as e:
            if "UNIQUE" in str(e):
                raise ApiError(409, "Dieser Name ist schon vergeben")
            raise ApiError(400, "Daten passen nicht zusammen")
    return wrapper


# ---------------------------------------------------------------- Handler

def expense_fields(con, b):
    cat = b.get("category_id")
    if isinstance(cat, bool) or not isinstance(cat, int):
        raise ApiError(400, "Kategorie fehlt")
    need(con, "categories", cat)
    return (
        v_date(b.get("date")),
        v_text(b.get("shop"), "Geschäft", max_len=80),
        v_cents(b.get("amount"), allow_negative=True),  # negativ = Gutschrift/Pfand
        cat,
        v_text(b.get("note"), "Notiz", required=False, max_len=300),
    )


def h_expense_create(con, b):
    f = expense_fields(con, b)
    cur = con.execute("INSERT INTO expenses (date, shop, amount, category_id, note) VALUES (?,?,?,?,?)", f)
    return dict(con.execute("SELECT id, date, shop, amount, category_id, note FROM expenses WHERE id=?", (cur.lastrowid,)).fetchone())


def h_expense_update(con, b, id_):
    need(con, "expenses", id_)
    f = expense_fields(con, b)
    con.execute("UPDATE expenses SET date=?, shop=?, amount=?, category_id=?, note=? WHERE id=?", (*f, id_))
    return dict(con.execute("SELECT id, date, shop, amount, category_id, note FROM expenses WHERE id=?", (id_,)).fetchone())


def h_expense_delete(con, b, id_):
    need(con, "expenses", id_)
    con.execute("DELETE FROM expenses WHERE id=?", (id_,))
    return {"ok": True}


@unique_guard
def h_category_create(con, b):
    cur = con.execute(
        "INSERT INTO categories (name, color, icon) VALUES (?,?,?)",
        (v_text(b.get("name"), "Name", max_len=40), v_color(b.get("color", "#898781")), v_icon(b.get("icon", "tag"))),
    )
    return need(con, "categories", cur.lastrowid)


@unique_guard
def h_category_update(con, b, id_):
    c = need(con, "categories", id_)
    con.execute(
        "UPDATE categories SET name=?, color=?, icon=?, archived=? WHERE id=?",
        (
            v_text(b.get("name", c["name"]), "Name", max_len=40),
            v_color(b.get("color", c["color"])),
            v_icon(b.get("icon", c["icon"])),
            1 if b.get("archived", c["archived"]) else 0,
            id_,
        ),
    )
    return need(con, "categories", id_)


def h_category_delete(con, b, id_):
    need(con, "categories", id_)
    n = con.execute("SELECT COUNT(*) FROM expenses WHERE category_id=?", (id_,)).fetchone()[0]
    if n:
        raise ApiError(409, f"Die Kategorie wird noch von {n} Ausgaben verwendet. Leg sie zuerst mit einer anderen zusammen.")
    con.execute("DELETE FROM categories WHERE id=?", (id_,))
    return {"ok": True}


def h_category_merge(con, b, id_):
    need(con, "categories", id_)
    into = b.get("into")
    if into == id_:
        raise ApiError(400, "Eine Kategorie kann nicht mit sich selbst zusammengelegt werden")
    need(con, "categories", into)
    n = con.execute("UPDATE expenses SET category_id=? WHERE category_id=?", (into, id_)).rowcount
    con.execute("DELETE FROM categories WHERE id=?", (id_,))
    return {"ok": True, "moved": n}


def h_shop_rename(con, b):
    old = v_text(b.get("from"), "Alter Name", max_len=80)
    new = v_text(b.get("to"), "Neuer Name", max_len=80)
    n = con.execute("UPDATE expenses SET shop=? WHERE shop=?", (new, old)).rowcount
    return {"ok": True, "changed": n}


def pot_fields(b, current=None):
    current = current or {}
    target = b.get("target", current.get("target"))
    if target is not None:
        target = v_cents(target, "Sparziel")
    return (
        v_text(b.get("name", current.get("name")), "Name", max_len=40),
        v_color(b.get("color", current.get("color", "#2a78d6"))),
        v_icon(b.get("icon", current.get("icon", "piggy-bank"))),
        target,
        v_text(b.get("note", current.get("note", "")), "Notiz", required=False, max_len=300),
        1 if b.get("archived", current.get("archived", 0)) else 0,
    )


@unique_guard
def h_pot_create(con, b):
    cur = con.execute("INSERT INTO pots (name, color, icon, target, note, archived) VALUES (?,?,?,?,?,?)", pot_fields(b))
    return need(con, "pots", cur.lastrowid)


@unique_guard
def h_pot_update(con, b, id_):
    p = need(con, "pots", id_)
    con.execute("UPDATE pots SET name=?, color=?, icon=?, target=?, note=?, archived=? WHERE id=?", (*pot_fields(b, p), id_))
    return need(con, "pots", id_)


def h_pot_delete(con, b, id_):
    need(con, "pots", id_)
    con.execute("DELETE FROM pot_tx WHERE pot_id=?", (id_,))
    con.execute("DELETE FROM pots WHERE id=?", (id_,))
    return {"ok": True}


def h_pot_tx_create(con, b):
    pot = b.get("pot_id")
    need(con, "pots", pot)
    cur = con.execute(
        "INSERT INTO pot_tx (pot_id, date, amount, note) VALUES (?,?,?,?)",
        (pot, v_date(b.get("date")), v_cents(b.get("amount"), allow_negative=True),
         v_text(b.get("note"), "Notiz", required=False, max_len=300)),
    )
    return need(con, "pot_tx", cur.lastrowid)


def h_pot_tx_delete(con, b, id_):
    need(con, "pot_tx", id_)
    con.execute("DELETE FROM pot_tx WHERE id=?", (id_,))
    return {"ok": True}


def recurring_fields(b, current=None):
    c = current or {}
    kind = b.get("kind", c.get("kind"))
    if kind not in ("income", "expense"):
        raise ApiError(400, "Art muss Einnahme oder Ausgabe sein")
    interval = b.get("interval", c.get("interval", 1))
    if interval not in (1, 2, 3, 6, 12):
        raise ApiError(400, "Rhythmus ungültig")
    return (
        kind,
        v_text(b.get("name", c.get("name")), "Bezeichnung", max_len=80),
        v_cents(b.get("amount", c.get("amount"))),
        interval,
        v_text(b.get("grp", c.get("grp", "")), "Gruppe", required=False, max_len=40),
        1 if b.get("variable", c.get("variable", 0)) else 0,
        v_text(b.get("note", c.get("note", "")), "Notiz", required=False, max_len=300),
        1 if b.get("active", c.get("active", 1)) else 0,
    )


def h_recurring_create(con, b):
    cur = con.execute(
        "INSERT INTO recurring (kind, name, amount, interval, grp, variable, note, active) VALUES (?,?,?,?,?,?,?,?)",
        recurring_fields(b),
    )
    return need(con, "recurring", cur.lastrowid)


def h_recurring_update(con, b, id_):
    r = need(con, "recurring", id_)
    con.execute(
        "UPDATE recurring SET kind=?, name=?, amount=?, interval=?, grp=?, variable=?, note=?, active=? WHERE id=?",
        (*recurring_fields(b, r), id_),
    )
    return need(con, "recurring", id_)


def h_recurring_delete(con, b, id_):
    need(con, "recurring", id_)
    con.execute("DELETE FROM recurring WHERE id=?", (id_,))
    return {"ok": True}


# ---------------------------------------------------------------- Abos

URL_RE = re.compile(r"^https?://[^\s]+$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def sub_fields(b, c=None):
    c = c or {}
    g = lambda k, d=None: b.get(k, c.get(k, d))  # noqa: E731
    interval = g("interval", 1)
    if interval not in (1, 2, 3, 6, 12, 24):
        raise ApiError(400, "Rhythmus ungültig")
    url = v_text(g("url", ""), "Webseite", required=False, max_len=500)
    if url and not URL_RE.match(url):
        raise ApiError(400, "Die Webseite muss mit http:// oder https:// beginnen")
    status = g("status", "active")
    if status not in ("active", "cancelled"):
        raise ApiError(400, "Status ungültig")
    mode = g("remind_mode", "none")
    if mode not in ("none", "before", "date"):
        raise ApiError(400, "Erinnerungsart ungültig")
    days = g("remind_days", 7)
    if isinstance(days, bool) or not isinstance(days, int) or not 0 <= days <= 365:
        raise ApiError(400, "Tage vor der Abbuchung: 0 bis 365")
    rdate = g("remind_date")
    if mode == "date":
        rdate = v_date(rdate, "Erinnerungsdatum")
    elif rdate:
        rdate = v_date(rdate, "Erinnerungsdatum")
    else:
        rdate = None
    snooze = g("snooze_until")
    snooze = v_date(snooze, "Später erinnern") if snooze else None
    provider = g("provider", "other")
    if not isinstance(provider, str) or not re.match(r"^[a-z0-9-]{1,30}$", provider):
        raise ApiError(400, "Anbieter ungültig")
    return (
        v_text(g("name"), "Name", max_len=80), provider, url,
        v_cents(g("amount"), allow_zero=True), interval, v_date(g("next_due"), "Nächste Abbuchung"),
        v_text(g("note", ""), "Notiz", required=False, max_len=300), status,
        mode, days, rdate,
        1 if g("ch_page", 1) else 0, 1 if g("ch_browser", 0) else 0, 1 if g("ch_email", 0) else 0,
        v_text(g("ack_key", ""), "ack", required=False, max_len=40), snooze,
    )


SUB_COLS = "name, provider, url, amount, interval, next_due, note, status, remind_mode, remind_days, remind_date, ch_page, ch_browser, ch_email, ack_key, snooze_until"


def h_sub_create(con, b):
    cur = con.execute(f"INSERT INTO subs ({SUB_COLS}) VALUES ({','.join('?' * 16)})", sub_fields(b))
    return need(con, "subs", cur.lastrowid)


def h_sub_update(con, b, id_):
    c = need(con, "subs", id_)
    sets = ", ".join(f"{k.strip()}=?" for k in SUB_COLS.split(","))
    con.execute(f"UPDATE subs SET {sets} WHERE id=?", (*sub_fields(b, c), id_))
    return need(con, "subs", id_)


def h_sub_delete(con, b, id_):
    need(con, "subs", id_)
    con.execute("DELETE FROM subs WHERE id=?", (id_,))
    return {"ok": True}


def excluded_fields(b, c=None):
    c = c or {}
    start = v_date(b.get("day_from", c.get("day_from")), "Von")
    end = v_date(b.get("day_to", c.get("day_to")), "Bis")
    if end < start:
        start, end = end, start
    if (date.fromisoformat(end) - date.fromisoformat(start)).days > 3660:
        raise ApiError(400, "Der Zeitraum ist zu lang (höchstens 10 Jahre)")
    return start, end, v_text(b.get("label", c.get("label", "")), "Bezeichnung", required=False, max_len=60)


def h_excluded_create(con, b):
    cur = con.execute("INSERT INTO pauses (day_from, day_to, label) VALUES (?,?,?)", excluded_fields(b))
    return need(con, "pauses", cur.lastrowid)


def h_excluded_update(con, b, id_):
    c = need(con, "pauses", id_)
    con.execute("UPDATE pauses SET day_from=?, day_to=?, label=? WHERE id=?", (*excluded_fields(b, c), id_))
    return need(con, "pauses", id_)


def h_excluded_delete(con, b, id_):
    need(con, "pauses", id_)
    con.execute("DELETE FROM pauses WHERE id=?", (id_,))
    return {"ok": True}


def h_settings(con, b):
    if "tracking_start" in b:
        ts = b.get("tracking_start") or ""
        set_setting(con, "tracking_start", v_date(ts, "Erfassung seit") if ts else "")
    if "notify_email" in b:
        mail = v_text(b.get("notify_email"), "E-Mail", required=False, max_len=200)
        if mail and not EMAIL_RE.match(mail):
            raise ApiError(400, "Das sieht nicht wie eine E-Mail-Adresse aus")
        set_setting(con, "notify_email", mail)
    return {"ok": True, "notify_email": get_setting(con, "notify_email", ""), "tracking_start": get_setting(con, "tracking_start", "")}


# --- Erinnerungen (gleiche Regeln wie in der Oberfläche, static/subs.js)

def add_months(d, n):
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year
    return date(y, m + 1, min(d.day, calendar.monthrange(y, m + 1)[1]))


def effective_due(sub, today):
    """Nächste Abbuchung ab heute – zählt das gespeicherte Datum im Abo-Rhythmus weiter."""
    base = date.fromisoformat(sub["next_due"])
    d, k = base, 0
    while d < today and k < 2000:
        k += 1
        d = add_months(base, k * sub["interval"])
    return d


def active_reminder(sub, today):
    if sub["status"] != "active" or sub["remind_mode"] == "none":
        return None
    due = effective_due(sub, today)
    if sub["remind_mode"] == "before":
        trigger, key = due - timedelta(days=sub["remind_days"]), "b" + due.isoformat()
    else:
        if not sub["remind_date"]:
            return None
        trigger, key = date.fromisoformat(sub["remind_date"]), "d" + sub["remind_date"]
    if today < trigger or sub["ack_key"] == key:
        return None
    if sub["snooze_until"] and today < date.fromisoformat(sub["snooze_until"]):
        return None
    return {"key": key, "trigger": trigger, "due": due}


# --- E-Mail

def smtp_config():
    host = os.environ.get("HB_SMTP_HOST")
    if not host:
        return None
    port = int(os.environ.get("HB_SMTP_PORT", "465"))
    user = os.environ.get("HB_SMTP_USER", "")
    return {
        "host": host, "port": port, "user": user,
        "password": os.environ.get("HB_SMTP_PASSWORD", ""),
        "sender": os.environ.get("HB_SMTP_FROM", user),
        # ssl (Port 465), starttls (Port 587) oder none (nur für lokale Tests)
        "security": os.environ.get("HB_SMTP_SECURITY", {465: "ssl", 587: "starttls"}.get(port, "none")),
    }


def send_mail(to, subject, body):
    cfg = smtp_config()
    if not cfg:
        raise ApiError(400, "Auf dem Server ist noch kein E-Mail-Versand eingerichtet (siehe README)")
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, cfg["sender"], to
    msg.set_content(body)
    ctx = ssl.create_default_context()
    try:
        if cfg["security"] == "ssl":
            conn = smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=20, context=ctx)
        else:
            conn = smtplib.SMTP(cfg["host"], cfg["port"], timeout=20)
        with conn as s:
            if cfg["security"] == "starttls":
                s.starttls(context=ctx)
            if cfg["user"]:
                s.login(cfg["user"], cfg["password"])
            s.send_message(msg)
    except (smtplib.SMTPException, OSError) as e:
        raise ApiError(502, f"E-Mail konnte nicht gesendet werden: {e}")


def euro_text(cents):
    s = f"{abs(cents) / 100:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return ("-" if cents < 0 else "") + s + " €"


def check_reminder_mails():
    """Schickt für fällige Erinnerungen mit E-Mail-Kanal eine Sammelmail (jede Erinnerung nur einmal)."""
    if not smtp_config():
        return 0
    today = date.today()
    with WRITE_LOCK, db() as con:
        to = get_setting(con, "notify_email", "") or os.environ.get("HB_NOTIFY_TO", "")
        if not to:
            return 0
        due = []
        for sub in rows(con, "SELECT * FROM subs WHERE ch_email=1 AND status='active'"):
            r = active_reminder(sub, today)
            if r:
                mark = r["key"] + "|" + (sub["snooze_until"] or "")
                if sub["email_key"] != mark:
                    due.append((sub, r, mark))
        if not due:
            return 0
        base = os.environ.get("HB_BASE_URL", "").rstrip("/")
        lines = ["Servus!", "", "Diese Abos solltest Du Dir anschauen:", ""]
        for sub, r, _ in due:
            lines.append(f"• {sub['name']} – {euro_text(sub['amount'])}, nächste Abbuchung am {r['due'].strftime('%d.%m.%Y')}")
            if sub["note"]:
                lines.append(f"  {sub['note']}")
            if sub["url"]:
                lines.append(f"  Kündigen/verwalten: {sub['url']}")
            lines.append("")
        if base:
            lines.append(f"Zur Übersicht: {base}/#monat")
        lines.append("")
        lines.append("– Dein Haushaltsbuch")
        subject = "Abo-Erinnerung: " + ", ".join(s["name"] for s, _, _ in due)
        send_mail(to, subject[:150], "\n".join(lines))
        for sub, _, mark in due:
            con.execute("UPDATE subs SET email_key=? WHERE id=?", (mark, sub["id"]))
        return len(due)


def reminder_loop():
    while True:
        try:
            n = check_reminder_mails()
            if n:
                sys.stderr.write(f"Abo-Erinnerung per E-Mail verschickt ({n})\n")
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"Erinnerungs-E-Mail fehlgeschlagen: {e!r}\n")
        time.sleep(1800)


def test_email():
    with db() as con:
        to = get_setting(con, "notify_email", "") or os.environ.get("HB_NOTIFY_TO", "")
    if not to:
        raise ApiError(400, "Bitte zuerst eine E-Mail-Adresse eintragen und speichern")
    send_mail(to, "Haushaltsbuch: Test-E-Mail", "Servus!\n\nDer E-Mail-Versand für Abo-Erinnerungen funktioniert. 🎉\n\n– Dein Haushaltsbuch")
    return {"ok": True, "to": to}


# ---------------------------------------------------------------- Export/Import

def export_data(con):
    cats = {c["id"]: c["name"] for c in rows(con, "SELECT id, name FROM categories")}
    pots = {p["id"]: p["name"] for p in rows(con, "SELECT id, name FROM pots")}
    return {
        "app": "haushaltsbuch",
        "version": EXPORT_VERSION,
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "categories": rows(con, "SELECT name, color, icon, archived FROM categories ORDER BY name"),
        "expenses": [
            {"date": e["date"], "shop": e["shop"], "amount": e["amount"], "category": cats[e["category_id"]], "note": e["note"]}
            for e in rows(con, "SELECT * FROM expenses ORDER BY date, id")
        ],
        "pots": rows(con, "SELECT name, color, icon, target, note, archived FROM pots ORDER BY name"),
        "pot_tx": [
            {"pot": pots[t["pot_id"]], "date": t["date"], "amount": t["amount"], "note": t["note"]}
            for t in rows(con, "SELECT * FROM pot_tx ORDER BY date, id")
        ],
        "recurring": rows(con, "SELECT kind, name, amount, interval, grp, variable, note, active FROM recurring"),
        "subs": rows(con, f"SELECT {SUB_COLS} FROM subs ORDER BY name"),
        "excluded": rows(con, "SELECT day_from, day_to, label FROM pauses ORDER BY day_from"),
        "settings": {"notify_email": get_setting(con, "notify_email", ""), "tracking_start": get_setting(con, "tracking_start", "")},
    }


def import_data(con, data):
    """Ersetzt den kompletten Datenbestand durch den Inhalt einer Exportdatei."""
    if not isinstance(data, dict) or data.get("app") != "haushaltsbuch":
        raise ApiError(400, "Das ist keine Haushaltsbuch-Exportdatei")
    for t in ("pot_tx", "pots", "expenses", "categories", "recurring"):
        con.execute(f"DELETE FROM {t}")
    cat_ids = {}
    for c in data.get("categories", []):
        cur = con.execute(
            "INSERT INTO categories (name, color, icon, archived) VALUES (?,?,?,?)",
            (v_text(c.get("name"), "Kategorie", max_len=40), v_color(c.get("color", "#898781")),
             v_icon(c.get("icon", "tag")), 1 if c.get("archived") else 0),
        )
        cat_ids[c["name"].strip().lower()] = cur.lastrowid
    for i, e in enumerate(data.get("expenses", []), 1):
        key = (e.get("category") or "").strip().lower()
        if key not in cat_ids:
            raise ApiError(400, f"Ausgabe {i}: unbekannte Kategorie „{e.get('category')}“")
        con.execute(
            "INSERT INTO expenses (date, shop, amount, category_id, note) VALUES (?,?,?,?,?)",
            (v_date(e.get("date")), v_text(e.get("shop"), "Geschäft", max_len=80),
             v_cents(e.get("amount"), allow_negative=True), cat_ids[key],
             v_text(e.get("note"), "Notiz", required=False, max_len=300)),
        )
    pot_ids = {}
    for p in data.get("pots", []):
        cur = con.execute("INSERT INTO pots (name, color, icon, target, note, archived) VALUES (?,?,?,?,?,?)", pot_fields(p))
        pot_ids[p["name"].strip().lower()] = cur.lastrowid
    for t in data.get("pot_tx", []):
        key = (t.get("pot") or "").strip().lower()
        if key not in pot_ids:
            raise ApiError(400, f"Unbekannter Spartopf „{t.get('pot')}“")
        con.execute(
            "INSERT INTO pot_tx (pot_id, date, amount, note) VALUES (?,?,?,?)",
            (pot_ids[key], v_date(t.get("date")), v_cents(t.get("amount"), allow_negative=True),
             v_text(t.get("note"), "Notiz", required=False, max_len=300)),
        )
    for r in data.get("recurring", []):
        con.execute(
            "INSERT INTO recurring (kind, name, amount, interval, grp, variable, note, active) VALUES (?,?,?,?,?,?,?,?)",
            recurring_fields(r),
        )
    if "subs" in data:  # ältere Exportdateien ohne Abos lassen vorhandene Abos stehen
        con.execute("DELETE FROM subs")
        for sb in data.get("subs", []):
            con.execute(f"INSERT INTO subs ({SUB_COLS}) VALUES ({','.join('?' * 16)})", sub_fields(sb))
    if "excluded" in data:
        con.execute("DELETE FROM pauses")
        for ex in data.get("excluded", []):
            con.execute("INSERT INTO pauses (day_from, day_to, label) VALUES (?,?,?)", excluded_fields(ex))
    if isinstance(data.get("settings"), dict):
        h_settings(con, {k: v for k, v in data["settings"].items() if k in ("notify_email", "tracking_start")})
    return {"ok": True, "expenses": len(data.get("expenses", [])), "categories": len(cat_ids)}


# ---------------------------------------------------------------- Routing

ROUTES = [
    ("POST", r"/api/expenses", h_expense_create),
    ("PUT", r"/api/expenses/(\d+)", h_expense_update),
    ("DELETE", r"/api/expenses/(\d+)", h_expense_delete),
    ("POST", r"/api/categories", h_category_create),
    ("PUT", r"/api/categories/(\d+)", h_category_update),
    ("DELETE", r"/api/categories/(\d+)", h_category_delete),
    ("POST", r"/api/categories/(\d+)/merge", h_category_merge),
    ("POST", r"/api/shops/rename", h_shop_rename),
    ("POST", r"/api/pots", h_pot_create),
    ("PUT", r"/api/pots/(\d+)", h_pot_update),
    ("DELETE", r"/api/pots/(\d+)", h_pot_delete),
    ("POST", r"/api/pot_tx", h_pot_tx_create),
    ("DELETE", r"/api/pot_tx/(\d+)", h_pot_tx_delete),
    ("POST", r"/api/recurring", h_recurring_create),
    ("PUT", r"/api/recurring/(\d+)", h_recurring_update),
    ("DELETE", r"/api/recurring/(\d+)", h_recurring_delete),
    ("POST", r"/api/subs", h_sub_create),
    ("PUT", r"/api/subs/(\d+)", h_sub_update),
    ("DELETE", r"/api/subs/(\d+)", h_sub_delete),
    ("PUT", r"/api/settings", h_settings),
    ("POST", r"/api/excluded", h_excluded_create),
    ("PUT", r"/api/excluded/(\d+)", h_excluded_update),
    ("DELETE", r"/api/excluded/(\d+)", h_excluded_delete),
    ("POST", r"/api/import", import_data),
]
ROUTES = [(m, re.compile("^" + p + "$"), f) for m, p, f in ROUTES]


class Handler(BaseHTTPRequestHandler):
    server_version = "Haushaltsbuch/1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    # --- statische Dateien
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/data":
            with db() as con:
                return self.send_json(200, all_data(con))
        if path == "/api/export":
            with db() as con:
                name = f"haushaltsbuch-{date.today().isoformat()}.json"
                return self.send_json(200, export_data(con), {"Content-Disposition": f'attachment; filename="{name}"'})
        if path.startswith("/api/"):
            return self.send_json(404, {"error": "Unbekannte Adresse"})
        if path == "/":
            path = "/index.html"
        file = (STATIC / path.lstrip("/")).resolve()
        if not str(file).startswith(str(STATIC)) or not file.is_file():
            self.send_error(404)
            return
        data = file.read_bytes()
        ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def handle_write(self, method):
        path = urlparse(self.path).path
        # Schutz vor fremden Formularen: nur echte JSON-Anfragen annehmen
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self.send_json(415, {"error": "JSON erwartet"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 20_000_000:
                raise ApiError(413, "Anfrage zu groß")
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            if method == "POST" and path == "/api/test-email":  # ohne Schreibsperre, SMTP kann dauern
                return self.send_json(200, test_email())
            for m, pattern, fn in ROUTES:
                match = pattern.match(path)
                if m == method and match:
                    args = [int(g) for g in match.groups()]
                    with WRITE_LOCK, db() as con:
                        result = fn(con, body, *args)
                    return self.send_json(200, result)
            raise ApiError(404, "Unbekannte Adresse")
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Ungültiges JSON"})
        except Exception as e:  # noqa: BLE001
            self.log_message("Fehler: %r", e)
            self.send_json(500, {"error": "Interner Fehler"})

    def do_POST(self):
        self.handle_write("POST")

    def do_PUT(self):
        self.handle_write("PUT")

    def do_DELETE(self):
        self.handle_write("DELETE")


def main():
    global DB_PATH
    ap = argparse.ArgumentParser(description="Haushaltsbuch-Server")
    ap.add_argument("--host", default=os.environ.get("HB_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("HB_PORT", "8085")))
    ap.add_argument("--db", default=os.environ.get("HB_DB", str(DB_PATH)))
    ap.add_argument("--import", dest="import_file", help="Exportdatei einspielen (ersetzt alle Daten) und beenden")
    args = ap.parse_args()
    DB_PATH = Path(args.db).resolve()
    init_db()

    if args.import_file:
        data = json.loads(Path(args.import_file).read_text(encoding="utf-8"))
        try:
            with db() as con:
                res = import_data(con, data)
        except ApiError as e:
            sys.exit(f"Import fehlgeschlagen: {e.message}")
        print(f"Import fertig: {res['expenses']} Ausgaben, {res['categories']} Kategorien → {DB_PATH}")
        return

    threading.Thread(target=reminder_loop, daemon=True, name="erinnerungen").start()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Haushaltsbuch läuft auf http://{args.host}:{args.port}  (Datenbank: {DB_PATH})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
