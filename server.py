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
import json
import mimetypes
import os
import re
import sqlite3
import sys
import threading
from contextlib import contextmanager
from datetime import date, datetime
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
    }


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

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Haushaltsbuch läuft auf http://{args.host}:{args.port}  (Datenbank: {DB_PATH})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
