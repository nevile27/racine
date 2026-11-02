#!/usr/bin/env python3
"""Racine — arbre de la famille, avec validation par l'administrateur.

Lancement :
    python3 app.py

Puis ouvrir http://127.0.0.1:5000

Sur le réseau de la maison :
    python3 app.py --host 0.0.0.0

Le premier compte créé est l'administrateur. Les autres rejoignent
avec le code famille. Leurs ajouts restent en teinte claire jusqu'à
validation.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import socket
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import wraps
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DB_PATH = DATA / "racine.db"
SECRET_PATH = DATA / "secret.key"

PERSON_COLUMNS = (
    "given_name",
    "family_name",
    "birth_date",
    "death_date",
    "place",
    "notes",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    given_name TEXT NOT NULL,
    family_name TEXT NOT NULL DEFAULT '',
    birth_date TEXT NOT NULL DEFAULT '',
    death_date TEXT NOT NULL DEFAULT '',
    place TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('approved', 'pending')),
    batch_id TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('parent', 'spouse')),
    person_a INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    person_b INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('approved', 'pending')),
    remove_proposed_by INTEGER REFERENCES users(id),
    batch_id TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique
    ON relations(kind, person_a, person_b);

CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('update', 'delete')),
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_proposal
    ON proposals(person_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    cover INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
);
"""

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_local = threading.local()
ROUTES = []


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_secret() -> str:
    DATA.mkdir(exist_ok=True)
    if SECRET_PATH.exists():
        secret = SECRET_PATH.read_text(encoding="utf-8").strip()
        if secret:
            return secret
    secret = secrets.token_hex(32)
    SECRET_PATH.write_text(secret, encoding="utf-8")
    return secret


SECRET = load_secret()


class _Session(dict):
    def __init__(self):
        super().__init__()
        self.dirty = False

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        self.dirty = True

    def clear(self):
        super().clear()
        self.dirty = True


class _SessionProxy:
    def get(self, key, default=None):
        return _local.session.get(key, default)

    def __setitem__(self, key, value):
        _local.session[key] = value

    def clear(self):
        _local.session.clear()

    def __setattr__(self, name, value):
        if name == "permanent":
            return
        raise AttributeError(name)


session = _SessionProxy()


def jsonify(*args, **kwargs):
    if kwargs:
        return dict(kwargs)
    if len(args) != 1:
        raise TypeError("Réponse invalide.")
    return args[0]


class HTML:
    def __init__(self, text: str):
        self.text = text


class FileResponse:
    def __init__(self, data: bytes, content_type: str):
        self.data = data
        self.content_type = content_type


class App:
    def get(self, path):
        return self._add("GET", path)

    def post(self, path):
        return self._add("POST", path)

    def patch(self, path):
        return self._add("PATCH", path)

    def delete(self, path):
        return self._add("DELETE", path)

    def _add(self, method, path):
        pattern = "^" + re.sub(r"<int:(\w+)>", r"(?P<\1>[0-9]+)", path) + "$"
        compiled = re.compile(pattern)

        def decorator(fn):
            ROUTES.append((method, compiled, fn))
            return fn

        return decorator


app = App()


def generate_code() -> str:
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def normalize_code(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


@contextmanager
def db_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    DATA.mkdir(exist_ok=True)
    with db_conn() as db:
        db.executescript(SCHEMA)


def fail(message: str, code: int = 400):
    return jsonify(error=message), code


def read_json() -> dict:
    data = getattr(_local, "body", None)
    if not isinstance(data, dict):
        raise ValueError("Requête invalide.")
    return data


def require_text(value, label: str, max_len: int, required: bool = False) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if required and not text:
        raise ValueError(f"{label} est obligatoire.")
    if len(text) > max_len:
        raise ValueError(f"{label} est trop long.")
    return text


def clean_notes(value) -> str:
    text = str(value or "").replace("\r\n", "\n").strip()
    if len(text) > 2000:
        raise ValueError("La note est trop longue.")
    return text


def clean_date(value, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError(f"{label} n'est pas une date valide.") from exc
    return text


def person_fields(data: dict) -> dict:
    fields = {
        "given_name": require_text(data.get("given_name"), "Le prénom", 80, required=True),
        "family_name": require_text(data.get("family_name"), "Le nom", 80),
        "birth_date": clean_date(data.get("birth_date"), "La date de naissance"),
        "death_date": clean_date(data.get("death_date"), "La date de décès"),
        "place": require_text(data.get("place"), "Le lieu", 120),
        "notes": clean_notes(data.get("notes")),
    }
    if fields["birth_date"] and fields["death_date"] and fields["death_date"] < fields["birth_date"]:
        raise ValueError("La date de décès est antérieure à la naissance.")
    return fields


def check_password_rules(password) -> str:
    if not isinstance(password, str) or len(password) < 4:
        raise ValueError("Le mot de passe doit contenir au moins 4 caractères.")
    if len(password) > 200:
        raise ValueError("Le mot de passe est trop long.")
    return password


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 200_000
    ).hex()
    return f"{salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    salt, _, digest = stored.partition("$")
    if not salt or not digest:
        return False
    check = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 200_000
    ).hex()
    return secrets.compare_digest(check, digest)


def user_public(row) -> dict:
    return {"id": row["id"], "name": row["name"], "role": row["role"]}


def public_user(db, row) -> dict | None:
    if not row:
        return None
    data = user_public(row)
    if is_door(db, row["id"]):
        data["shared"] = True
    return data


def is_door(db, user_id) -> bool:
    door = get_setting(db, "door_user_id")
    return bool(door) and str(user_id) == str(door)


def ensure_door_user(db):
    door_id = get_setting(db, "door_user_id")
    if door_id:
        row = db.execute(
            "SELECT id, name, role FROM users WHERE id = ?", (int(door_id),)
        ).fetchone()
        if row:
            return row
    name = "Famille"
    suffix = 2
    while name_taken(db, name):
        name = f"Famille {suffix}"
        suffix += 1
    db.execute(
        "INSERT INTO users (name, password_hash, role, created_at) VALUES (?, ?, 'member', ?)",
        (name, hash_password(secrets.token_urlsafe(32)), now()),
    )
    user_id = db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    set_setting(db, "door_user_id", str(user_id))
    return db.execute(
        "SELECT id, name, role FROM users WHERE id = ?", (user_id,)
    ).fetchone()


def person_json(row) -> dict:
    return {
        "id": row["id"],
        "given_name": row["given_name"],
        "family_name": row["family_name"],
        "birth_date": row["birth_date"],
        "death_date": row["death_date"],
        "place": row["place"],
        "notes": row["notes"],
        "status": row["status"],
        "batch_id": row["batch_id"],
        "created_by": row["created_by"],
        "created_by_name": row["created_by_name"],
        "created_at": row["created_at"],
    }


def photo_dir() -> Path:
    path = DATA / "photos"
    path.mkdir(parents=True, exist_ok=True)
    return path


def photo_file(photo_id: int) -> Path:
    return photo_dir() / f"{int(photo_id)}.jpg"


def delete_person_photos(db, person_id: int) -> None:
    rows = db.execute("SELECT id FROM photos WHERE person_id = ?", (person_id,)).fetchall()
    for row in rows:
        photo_file(row["id"]).unlink(missing_ok=True)


def erase_person(db, person_id: int) -> None:
    delete_person_photos(db, person_id)
    db.execute("DELETE FROM people WHERE id = ?", (person_id,))


def decode_image(value) -> bytes:
    if not isinstance(value, str) or not value.startswith("data:image/"):
        raise ValueError("Choisissez une photo.")
    header, _, encoded = value.partition(",")
    if ";base64" not in header or not encoded:
        raise ValueError("Cette photo ne peut pas être lue.")
    mime = header[5:].split(";", 1)[0]
    if mime not in {"image/jpeg", "image/png", "image/webp", "image/gif"}:
        raise ValueError("Utilisez une photo au format habituel (JPEG ou PNG).")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("Cette photo ne peut pas être lue.") from exc
    if not raw or len(raw) > 2_500_000:
        raise ValueError("Cette photo est trop lourde.")
    if not raw.startswith(b"\xff\xd8"):
        raise ValueError("Cette photo ne peut pas être lue.")
    return raw


def relation_json(row) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "person_a": row["person_a"],
        "person_b": row["person_b"],
        "status": row["status"],
        "remove_proposed_by": row["remove_proposed_by"],
        "remove_proposed_by_name": row["remove_proposed_by_name"],
        "batch_id": row["batch_id"],
        "created_by": row["created_by"],
        "created_by_name": row["created_by_name"],
    }


def proposal_json(row) -> dict:
    try:
        payload = json.loads(row["payload"] or "{}")
    except json.JSONDecodeError:
        payload = {}
    return {
        "id": row["id"],
        "kind": row["kind"],
        "person_id": row["person_id"],
        "payload": payload,
        "created_by": row["created_by"],
        "created_by_name": row["created_by_name"],
        "created_at": row["created_at"],
    }


def get_setting(db, key: str) -> str | None:
    row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(db, key: str, value: str) -> None:
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def ensure_family_code(db) -> str:
    code = get_setting(db, "family_code")
    if code:
        return code
    code = generate_code()
    set_setting(db, "family_code", code)
    return code


def name_taken(db, name: str, ignore_id: int | None = None) -> bool:
    rows = db.execute("SELECT id, name FROM users").fetchall()
    folded = name.casefold()
    return any(row["name"].casefold() == folded and row["id"] != ignore_id for row in rows)


def tree_payload(db, user) -> dict:
    people = db.execute(
        """
        SELECT p.*, u.name AS created_by_name
        FROM people p
        LEFT JOIN users u ON u.id = p.created_by
        ORDER BY p.id
        """
    ).fetchall()
    relations = db.execute(
        """
        SELECT r.*, u.name AS created_by_name, ru.name AS remove_proposed_by_name
        FROM relations r
        LEFT JOIN users u ON u.id = r.created_by
        LEFT JOIN users ru ON ru.id = r.remove_proposed_by
        ORDER BY r.id
        """
    ).fetchall()
    proposals = db.execute(
        """
        SELECT pr.*, u.name AS created_by_name
        FROM proposals pr
        LEFT JOIN users u ON u.id = pr.created_by
        WHERE pr.status = 'pending'
        ORDER BY pr.id
        """
    ).fetchall()
    users = []
    if user["role"] == "admin":
        users = db.execute(
            "SELECT id, name, role, created_at FROM users ORDER BY id"
        ).fetchall()
    user_rows = []
    for row in users:
        item = dict(row)
        if is_door(db, item["id"]):
            item["shared"] = True
        user_rows.append(item)
    photo_rows = db.execute(
        "SELECT id, person_id FROM photos ORDER BY cover DESC, id"
    ).fetchall()
    photos_of = {}
    for row in photo_rows:
        photos_of.setdefault(row["person_id"], []).append(row["id"])
    people_json = []
    for row in people:
        item = person_json(row)
        item["photos"] = photos_of.get(row["id"], [])
        item["photo_id"] = item["photos"][0] if item["photos"] else None
        people_json.append(item)
    return {
        "people": people_json,
        "relations": [relation_json(row) for row in relations],
        "proposals": [proposal_json(row) for row in proposals],
        "family_code": ensure_family_code(db),
        "users": user_rows,
    }


def fetch_user(db):
    user_id = session.get("user_id")
    if not user_id:
        return None
    return db.execute(
        "SELECT id, name, role FROM users WHERE id = ?", (user_id,)
    ).fetchone()


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        with db_conn() as db:
            user = fetch_user(db)
        if not user:
            session.clear()
            return fail("Connexion requise.", 401)
        return fn(user_public(user), *args, **kwargs)

    return wrapper


def require_admin(user) -> None:
    if user["role"] != "admin":
        raise PermissionError("Seul l'administrateur peut faire cela.")


def ancestor_ids(db, person_id: int) -> set[int]:
    found: set[int] = set()
    stack = [person_id]
    seen = {person_id}
    while stack:
        current = stack.pop()
        rows = db.execute(
            "SELECT person_a FROM relations WHERE kind = 'parent' AND person_b = ?",
            (current,),
        ).fetchall()
        for row in rows:
            parent = row["person_a"]
            if parent in seen:
                continue
            seen.add(parent)
            found.add(parent)
            stack.append(parent)
    return found


def ensure_person(db, person_id: int):
    row = db.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
    if not row:
        raise ValueError("Cette personne est introuvable.")
    return row


def parent_count(db, child_id: int) -> int:
    row = db.execute(
        "SELECT COUNT(*) AS c FROM relations WHERE kind = 'parent' AND person_b = ?",
        (child_id,),
    ).fetchone()
    return row["c"]


def add_link(db, kind: str, a: int, b: int, user, status: str, batch_id: str | None) -> None:
    if a == b:
        raise ValueError("On ne peut pas relier une personne à elle-même.")
    ensure_person(db, a)
    ensure_person(db, b)
    if kind == "parent":
        parent, child = a, b
        if db.execute(
            "SELECT id FROM relations WHERE kind = 'parent' AND person_a = ? AND person_b = ?",
            (parent, child),
        ).fetchone():
            raise ValueError("Ce lien de parenté existe déjà.")
        if db.execute(
            """
            SELECT id FROM relations
            WHERE kind = 'spouse' AND person_a = ? AND person_b = ?
            """,
            ((parent, child) if parent < child else (child, parent)),
        ).fetchone():
            raise ValueError("Ces personnes sont déjà conjointes.")
        if parent in ancestor_ids(db, child):
            raise ValueError("Cette personne est déjà un ascendant.")
        if child in ancestor_ids(db, parent):
            raise ValueError("Ce lien créerait une boucle dans l'arbre.")
        if parent_count(db, child) >= 2:
            raise ValueError(
                "Deux parents sont déjà indiqués. Faites valider le retrait d'un lien avant d'en ajouter un autre."
            )
        db.execute(
            """
            INSERT INTO relations
                (kind, person_a, person_b, status, batch_id, created_by, created_at)
            VALUES ('parent', ?, ?, ?, ?, ?, ?)
            """,
            (parent, child, status, batch_id, user["id"], now()),
        )
        return
    if kind != "spouse":
        raise ValueError("Lien inconnu.")
    left, right = (a, b) if a < b else (b, a)
    if db.execute(
        "SELECT id FROM relations WHERE kind = 'spouse' AND person_a = ? AND person_b = ?",
        (left, right),
    ).fetchone():
        raise ValueError("Ce lien de conjoint existe déjà.")
    if a in ancestor_ids(db, b) or b in ancestor_ids(db, a):
        raise ValueError("Un parent et son enfant ne peuvent pas être conjoints.")
    db.execute(
        """
        INSERT INTO relations
            (kind, person_a, person_b, status, batch_id, created_by, created_at)
        VALUES ('spouse', ?, ?, ?, ?, ?, ?)
        """,
        (left, right, status, batch_id, user["id"], now()),
    )


def insert_person(db, fields: dict, user, status: str, batch_id: str) -> int:
    cursor = db.execute(
        """
        INSERT INTO people (
            given_name, family_name, birth_date, death_date, place, notes,
            status, batch_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            fields["given_name"],
            fields["family_name"],
            fields["birth_date"],
            fields["death_date"],
            fields["place"],
            fields["notes"],
            status,
            batch_id,
            user["id"],
            now(),
        ),
    )
    return cursor.lastrowid


def create_person_with_links(db, user, data: dict) -> int:
    fields = person_fields(data)
    kind = data.get("kind") or "root"
    if kind not in {"root", "child_of", "parent_of", "spouse_of", "sibling_of"}:
        raise ValueError("Choisissez un type de lien.")
    anchor_id = data.get("anchor_id")
    if kind != "root":
        if not isinstance(anchor_id, int):
            raise ValueError("Choisissez la personne à qui rattacher ce proche.")
        ensure_person(db, anchor_id)
    also = data.get("also_parent_ids") or []
    if not isinstance(also, list) or any(not isinstance(item, int) for item in also):
        raise ValueError("Requête invalide.")
    also_ids = [item for item in dict.fromkeys(also) if item != anchor_id]
    if len(also_ids) > 1:
        raise ValueError("Vous pouvez indiquer un seul autre parent.")
    status = "approved" if user["role"] == "admin" else "pending"
    batch_id = str(uuid.uuid4())
    person_id = insert_person(db, fields, user, status, batch_id)
    if kind == "child_of":
        add_link(db, "parent", anchor_id, person_id, user, status, batch_id)
        for extra in also_ids:
            add_link(db, "parent", extra, person_id, user, status, batch_id)
    elif kind == "parent_of":
        add_link(db, "parent", person_id, anchor_id, user, status, batch_id)
    elif kind == "spouse_of":
        add_link(db, "spouse", person_id, anchor_id, user, status, batch_id)
    elif kind == "sibling_of":
        parents = db.execute(
            "SELECT person_a FROM relations WHERE kind = 'parent' AND person_b = ?",
            (anchor_id,),
        ).fetchall()
        if not parents:
            raise ValueError("Ajoutez d'abord un parent, ou choisissez un autre lien.")
        for parent in parents:
            add_link(db, "parent", parent["person_a"], person_id, user, status, batch_id)
    return person_id


def pending_proposal(db, person_id: int):
    return db.execute(
        "SELECT * FROM proposals WHERE person_id = ? AND status = 'pending'",
        (person_id,),
    ).fetchone()


def apply_update(db, person_id: int, fields: dict) -> None:
    db.execute(
        """
        UPDATE people
        SET given_name = ?, family_name = ?, birth_date = ?, death_date = ?,
            place = ?, notes = ?
        WHERE id = ?
        """,
        (
            fields["given_name"],
            fields["family_name"],
            fields["birth_date"],
            fields["death_date"],
            fields["place"],
            fields["notes"],
            person_id,
        ),
    )


def save_person_changes(db, user, person_id: int, data: dict) -> None:
    person = ensure_person(db, person_id)
    fields = person_fields(data)
    same = all(fields[column] == person[column] for column in PERSON_COLUMNS)
    if person["status"] == "pending":
        if user["role"] != "admin" and person["created_by"] != user["id"]:
            raise ValueError("Seul l'auteur ou l'administrateur peut modifier cette proposition.")
        if same:
            raise ValueError("Aucun changement à enregistrer.")
        apply_update(db, person_id, fields)
        return
    existing = pending_proposal(db, person_id)
    if user["role"] == "admin" and not existing:
        if same:
            raise ValueError("Aucun changement à enregistrer.")
        apply_update(db, person_id, fields)
        return
    if existing and existing["kind"] == "delete":
        raise ValueError("Une suppression est déjà proposée pour cette personne.")
    if existing and existing["created_by"] != user["id"] and user["role"] != "admin":
        raise ValueError("Une modification est déjà en attente pour cette personne.")
    official = {column: person[column] for column in PERSON_COLUMNS}
    if fields == official:
        raise ValueError("Aucun changement à proposer.")
    payload = json.dumps(fields, ensure_ascii=False)
    if existing:
        author = existing["created_by"] if user["role"] == "admin" else user["id"]
        db.execute(
            "UPDATE proposals SET payload = ?, created_by = ?, created_at = ? WHERE id = ?",
            (payload, author, now(), existing["id"]),
        )
        return
    db.execute(
        """
        INSERT INTO proposals (kind, person_id, payload, status, created_by, created_at)
        VALUES ('update', ?, ?, 'pending', ?, ?)
        """,
        (person_id, payload, user["id"], now()),
    )


def delete_person(db, user, person_id: int) -> str:
    person = ensure_person(db, person_id)
    if person["status"] == "pending":
        if user["role"] != "admin" and person["created_by"] != user["id"]:
            raise ValueError("Seul l'auteur ou l'administrateur peut retirer cette proposition.")
        erase_person(db, person_id)
        return "deleted"
    if user["role"] == "admin":
        erase_person(db, person_id)
        return "deleted"
    existing = pending_proposal(db, person_id)
    if existing and existing["kind"] == "update":
        raise ValueError("Une modification est déjà en attente. Retirez-la avant de proposer la suppression.")
    if existing and existing["kind"] == "delete":
        if existing["created_by"] != user["id"]:
            raise ValueError("Une suppression est déjà proposée pour cette personne.")
        return "proposed"
    db.execute(
        """
        INSERT INTO proposals (kind, person_id, payload, status, created_by, created_at)
        VALUES ('delete', ?, '{}', 'pending', ?, ?)
        """,
        (person_id, user["id"], now()),
    )
    return "proposed"


def can_touch_relation(user, relation) -> bool:
    return user["role"] == "admin" or relation["created_by"] == user["id"]


def remove_relation(db, user, relation_id: int) -> str:
    relation = db.execute("SELECT * FROM relations WHERE id = ?", (relation_id,)).fetchone()
    if not relation:
        raise ValueError("Ce lien est introuvable.")
    if relation["status"] == "pending":
        if not can_touch_relation(user, relation):
            raise ValueError("Seul l'auteur ou l'administrateur peut retirer ce lien.")
        db.execute("DELETE FROM relations WHERE id = ?", (relation_id,))
        return "deleted"
    if user["role"] == "admin":
        db.execute("DELETE FROM relations WHERE id = ?", (relation_id,))
        return "deleted"
    if relation["remove_proposed_by"]:
        if relation["remove_proposed_by"] != user["id"]:
            raise ValueError("Un retrait est déjà proposé pour ce lien.")
        return "proposed"
    db.execute(
        "UPDATE relations SET remove_proposed_by = ? WHERE id = ?",
        (user["id"], relation_id),
    )
    return "proposed"


def approve_new_person(db, person_id: int) -> None:
    person = ensure_person(db, person_id)
    if person["status"] != "pending":
        raise ValueError("Cette fiche n'est pas en attente.")
    db.execute("UPDATE people SET status = 'approved' WHERE id = ?", (person_id,))
    if person["batch_id"]:
        db.execute(
            "UPDATE relations SET status = 'approved' WHERE batch_id = ? AND status = 'pending'",
            (person["batch_id"],),
        )


def review(db, user, action: str, kind: str, target_id: int) -> None:
    require_admin(user)
    if action not in {"approve", "reject"}:
        raise ValueError("Action inconnue.")
    if not isinstance(target_id, int):
        raise ValueError("Requête invalide.")
    if kind == "person":
        if action == "approve":
            approve_new_person(db, target_id)
        else:
            person = ensure_person(db, target_id)
            if person["status"] != "pending":
                raise ValueError("Cette fiche n'est pas en attente.")
            erase_person(db, target_id)
        return
    if kind == "proposal":
        prop = db.execute("SELECT * FROM proposals WHERE id = ?", (target_id,)).fetchone()
        if not prop or prop["status"] != "pending":
            raise ValueError("Cette proposition n'est plus en attente.")
        if action == "approve" and prop["kind"] == "update":
            apply_update(db, prop["person_id"], person_fields(json.loads(prop["payload"] or "{}")))
            db.execute(
                """
                UPDATE proposals
                SET status = 'approved', reviewed_by = ?, reviewed_at = ?
                WHERE id = ?
                """,
                (user["id"], now(), prop["id"]),
            )
        elif action == "approve" and prop["kind"] == "delete":
            erase_person(db, prop["person_id"])
        else:
            db.execute(
                """
                UPDATE proposals
                SET status = 'rejected', reviewed_by = ?, reviewed_at = ?
                WHERE id = ?
                """,
                (user["id"], now(), prop["id"]),
            )
        return
    if kind == "relation":
        relation = db.execute("SELECT * FROM relations WHERE id = ?", (target_id,)).fetchone()
        if not relation or relation["status"] != "pending":
            raise ValueError("Ce lien n'est pas en attente.")
        if action == "approve":
            db.execute("UPDATE relations SET status = 'approved' WHERE id = ?", (target_id,))
        else:
            db.execute("DELETE FROM relations WHERE id = ?", (target_id,))
        return
    if kind == "removal":
        relation = db.execute("SELECT * FROM relations WHERE id = ?", (target_id,)).fetchone()
        if not relation or not relation["remove_proposed_by"]:
            raise ValueError("Aucun retrait en attente pour ce lien.")
        if action == "approve":
            db.execute("DELETE FROM relations WHERE id = ?", (target_id,))
        else:
            db.execute(
                "UPDATE relations SET remove_proposed_by = NULL WHERE id = ?",
                (target_id,),
            )
        return
    raise ValueError("Type de proposition inconnu.")


def create_link(db, user, data: dict) -> None:
    person_id = data.get("person_id")
    other_id = data.get("other_id")
    role = data.get("role")
    if not isinstance(person_id, int) or not isinstance(other_id, int):
        raise ValueError("Choisissez deux personnes.")
    if role not in {"parent", "child", "spouse"}:
        raise ValueError("Choisissez un type de lien.")
    status = "approved" if user["role"] == "admin" else "pending"
    batch_id = str(uuid.uuid4())
    if role == "parent":
        add_link(db, "parent", other_id, person_id, user, status, batch_id)
    elif role == "child":
        add_link(db, "parent", person_id, other_id, user, status, batch_id)
    else:
        add_link(db, "spouse", person_id, other_id, user, status, batch_id)


@app.get("/")
def index():
    return HTML((ROOT / "templates" / "index.html").read_text(encoding="utf-8"))


@app.get("/api/status")
def status():
    with db_conn() as db:
        count = db.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        row = fetch_user(db)
        user = public_user(db, row)
    if session.get("user_id") and not row:
        session.clear()
    return jsonify(needs_setup=count == 0, user=user)


@app.post("/api/setup")
def setup():
    try:
        data = read_json()
        name = require_text(data.get("name"), "Le nom", 80, required=True)
        password = check_password_rules(data.get("password"))
        if password != data.get("password_confirm"):
            raise ValueError("Les deux mots de passe ne correspondent pas.")
        with db_conn() as db:
            count = db.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
            if count:
                raise ValueError("L'administrateur existe déjà.")
            db.execute(
                "INSERT INTO users (name, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)",
                (name, hash_password(password), now()),
            )
            user_id = db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            ensure_family_code(db)
            row = db.execute(
                "SELECT id, name, role FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            public = public_user(db, row)
        session.clear()
        session["user_id"] = row["id"]
        session.permanent = True
        return jsonify(user=public)
    except ValueError as exc:
        return fail(str(exc))


@app.post("/api/join")
def join():
    try:
        data = read_json()
        name = require_text(data.get("name"), "Le nom", 80, required=True)
        password = check_password_rules(data.get("password"))
        if password != data.get("password_confirm"):
            raise ValueError("Les deux mots de passe ne correspondent pas.")
        code = normalize_code(data.get("code") or "")
        with db_conn() as db:
            count = db.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
            if not count:
                raise ValueError("L'administrateur doit d'abord créer l'arbre.")
            expected = normalize_code(ensure_family_code(db))
            if not code or code != expected:
                raise ValueError("Ce code familial n'est pas le bon.")
            if name_taken(db, name):
                raise ValueError("Ce nom est déjà utilisé. Choisissez-en un autre, ou entrez avec le mot de passe déjà choisi.")
            db.execute(
                "INSERT INTO users (name, password_hash, role, created_at) VALUES (?, ?, 'member', ?)",
                (name, hash_password(password), now()),
            )
            user_id = db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            row = db.execute(
                "SELECT id, name, role FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            public = public_user(db, row)
        session.clear()
        session["user_id"] = row["id"]
        session.permanent = True
        return jsonify(user=public)
    except ValueError as exc:
        return fail(str(exc))


@app.post("/api/login")
def login():
    try:
        data = read_json()
        name = require_text(data.get("name"), "Le nom", 80, required=True)
        password = data.get("password")
        if not isinstance(password, str):
            raise ValueError("Nom ou mot de passe incorrect.")
        with db_conn() as db:
            rows = db.execute("SELECT id, name, role, password_hash FROM users").fetchall()
            row = next((item for item in rows if item["name"].casefold() == name.casefold()), None)
            if not row or not verify_password(password, row["password_hash"]):
                return fail("Nom ou mot de passe incorrect.", 401)
            public = public_user(db, row)
        session.clear()
        session["user_id"] = row["id"]
        session.permanent = True
        return jsonify(user=public)
    except ValueError as exc:
        return fail(str(exc))


@app.post("/api/code")
def code_login():
    try:
        data = read_json()
        with db_conn() as db:
            count = db.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
            if not count:
                raise ValueError(
                    "Il n'y a pas encore d'arbre. Ouvrez l'onglet Compte pour en créer un."
                )
            entered = normalize_code(data.get("code") or "")
            current = normalize_code(get_setting(db, "family_code") or "")
            if not entered or entered != current:
                raise ValueError("Ce code familial n'est pas le bon.")
            row = ensure_door_user(db)
            public = public_user(db, row)
        session.clear()
        session["user_id"] = row["id"]
        session.permanent = True
        return jsonify(user=public)
    except ValueError as exc:
        return fail(str(exc))


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.post("/api/account/password")
@login_required
def change_password(user):
    try:
        data = read_json()
        current = data.get("current_password")
        new_password = check_password_rules(data.get("new_password"))
        if new_password != data.get("password_confirm"):
            raise ValueError("Les deux mots de passe ne correspondent pas.")
        if not isinstance(current, str):
            raise ValueError("Le mot de passe actuel est incorrect.")
        with db_conn() as db:
            if is_door(db, user["id"]):
                raise ValueError("Cet accès utilise le code familial. Il n'a pas de mot de passe.")
            row = db.execute(
                "SELECT password_hash FROM users WHERE id = ?", (user["id"],)
            ).fetchone()
            if not row or not verify_password(current, row["password_hash"]):
                raise ValueError("Le mot de passe actuel est incorrect.")
            db.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (hash_password(new_password), user["id"]),
            )
        return jsonify(ok=True)
    except ValueError as exc:
        return fail(str(exc))


@app.get("/api/tree")
@login_required
def get_tree(user):
    with db_conn() as db:
        payload = tree_payload(db, user)
    return jsonify(payload)


@app.get("/api/photos/<int:photo_id>")
@login_required
def get_photo(user, photo_id):
    with db_conn() as db:
        row = db.execute("SELECT id FROM photos WHERE id = ?", (photo_id,)).fetchone()
    if not row:
        return fail("Cette photo est introuvable.", 404)
    path = photo_file(photo_id)
    if not path.is_file():
        return fail("Cette photo est introuvable.", 404)
    return FileResponse(path.read_bytes(), "image/jpeg")


@app.post("/api/people/<int:person_id>/photos")
@login_required
def add_photo(user, person_id):
    try:
        data = read_json()
        raw = decode_image(data.get("image"))
        with db_conn() as db:
            ensure_person(db, person_id)
            count = db.execute(
                "SELECT COUNT(*) AS c FROM photos WHERE person_id = ?", (person_id,)
            ).fetchone()["c"]
            if count >= 12:
                raise ValueError("Douze photos suffisent pour une fiche.")
            has_cover = db.execute(
                "SELECT id FROM photos WHERE person_id = ? AND cover = 1", (person_id,)
            ).fetchone()
            db.execute(
                "INSERT INTO photos (person_id, cover, created_by, created_at) VALUES (?, ?, ?, ?)",
                (person_id, 0 if has_cover else 1, user["id"], now()),
            )
            photo_id = db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            photo_file(photo_id).write_bytes(raw)
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))


@app.post("/api/photos/<int:photo_id>/cover")
@login_required
def cover_photo(user, photo_id):
    try:
        with db_conn() as db:
            row = db.execute("SELECT person_id FROM photos WHERE id = ?", (photo_id,)).fetchone()
            if not row:
                raise ValueError("Cette photo est introuvable.")
            db.execute("UPDATE photos SET cover = 0 WHERE person_id = ?", (row["person_id"],))
            db.execute("UPDATE photos SET cover = 1 WHERE id = ?", (photo_id,))
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))


@app.delete("/api/photos/<int:photo_id>")
@login_required
def remove_photo(user, photo_id):
    try:
        with db_conn() as db:
            row = db.execute(
                "SELECT id, person_id, cover, created_by FROM photos WHERE id = ?", (photo_id,)
            ).fetchone()
            if not row:
                raise ValueError("Cette photo est introuvable.")
            if user["role"] != "admin" and row["created_by"] != user["id"]:
                raise ValueError("Seul l'auteur ou l'administrateur peut retirer cette photo.")
            photo_file(photo_id).unlink(missing_ok=True)
            db.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
            if row["cover"]:
                nxt = db.execute(
                    "SELECT id FROM photos WHERE person_id = ? ORDER BY id LIMIT 1",
                    (row["person_id"],),
                ).fetchone()
                if nxt:
                    db.execute("UPDATE photos SET cover = 1 WHERE id = ?", (nxt["id"],))
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))


@app.post("/api/people")
@login_required
def create_person(user):
    try:
        data = read_json()
        with db_conn() as db:
            person_id = create_person_with_links(db, user, data)
            payload = tree_payload(db, user)
            row = next(item for item in payload["people"] if item["id"] == person_id)
            payload["person"] = row
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))
    except PermissionError as exc:
        return fail(str(exc), 403)


@app.patch("/api/people/<int:person_id>")
@login_required
def update_person(user, person_id):
    try:
        data = read_json()
        with db_conn() as db:
            save_person_changes(db, user, person_id, data)
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))


@app.delete("/api/people/<int:person_id>")
@login_required
def remove_person(user, person_id):
    try:
        with db_conn() as db:
            result = delete_person(db, user, person_id)
            payload = tree_payload(db, user)
            payload["result"] = result
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))


@app.post("/api/relations")
@login_required
def post_relation(user):
    try:
        data = read_json()
        with db_conn() as db:
            create_link(db, user, data)
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))


@app.delete("/api/relations/<int:relation_id>")
@login_required
def delete_relation(user, relation_id):
    try:
        with db_conn() as db:
            result = remove_relation(db, user, relation_id)
            payload = tree_payload(db, user)
            payload["result"] = result
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))


@app.post("/api/relations/<int:relation_id>/cancel-removal")
@login_required
def cancel_removal(user, relation_id):
    try:
        with db_conn() as db:
            relation = db.execute(
                "SELECT * FROM relations WHERE id = ?", (relation_id,)
            ).fetchone()
            if not relation or not relation["remove_proposed_by"]:
                raise ValueError("Aucun retrait en attente pour ce lien.")
            if user["role"] != "admin" and relation["remove_proposed_by"] != user["id"]:
                raise ValueError("Seul l'auteur ou l'administrateur peut annuler ce retrait.")
            db.execute(
                "UPDATE relations SET remove_proposed_by = NULL WHERE id = ?",
                (relation_id,),
            )
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))


@app.delete("/api/proposals/<int:proposal_id>")
@login_required
def withdraw_proposal(user, proposal_id):
    try:
        with db_conn() as db:
            prop = db.execute(
                "SELECT * FROM proposals WHERE id = ?", (proposal_id,)
            ).fetchone()
            if not prop or prop["status"] != "pending":
                raise ValueError("Cette proposition n'est plus en attente.")
            if user["role"] != "admin" and prop["created_by"] != user["id"]:
                raise ValueError("Seul l'auteur ou l'administrateur peut retirer cette proposition.")
            db.execute("DELETE FROM proposals WHERE id = ?", (proposal_id,))
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))


@app.post("/api/review")
@login_required
def post_review(user):
    try:
        data = read_json()
        with db_conn() as db:
            review(db, user, data.get("action"), data.get("kind"), data.get("id"))
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))
    except PermissionError as exc:
        return fail(str(exc), 403)


@app.post("/api/users")
@login_required
def create_user(user):
    try:
        data = read_json()
        require_admin(user)
        name = require_text(data.get("name"), "Le nom", 80, required=True)
        password = check_password_rules(data.get("password"))
        with db_conn() as db:
            if name_taken(db, name):
                raise ValueError("Ce nom est déjà utilisé.")
            db.execute(
                "INSERT INTO users (name, password_hash, role, created_at) VALUES (?, ?, 'member', ?)",
                (name, hash_password(password), now()),
            )
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))
    except PermissionError as exc:
        return fail(str(exc), 403)


@app.post("/api/users/<int:user_id>/password")
@login_required
def reset_user_password(user, user_id):
    try:
        data = read_json()
        require_admin(user)
        password = check_password_rules(data.get("password"))
        with db_conn() as db:
            row = db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                raise ValueError("Cette personne est introuvable.")
            if is_door(db, row["id"]):
                raise ValueError("Ce compte sert au code familial. Il n'a pas de mot de passe.")
            db.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (hash_password(password), user_id),
            )
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))
    except PermissionError as exc:
        return fail(str(exc), 403)


@app.post("/api/users/<int:user_id>/role")
@login_required
def change_role(user, user_id):
    try:
        data = read_json()
        require_admin(user)
        role = data.get("role")
        if role not in {"admin", "member"}:
            raise ValueError("Rôle inconnu.")
        with db_conn() as db:
            row = db.execute("SELECT id, role FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                raise ValueError("Cette personne est introuvable.")
            if is_door(db, row["id"]):
                raise ValueError("Ce compte sert au code familial. Il reste un accès simple.")
            if role == "member" and row["role"] == "admin":
                admins = db.execute(
                    "SELECT COUNT(*) AS c FROM users WHERE role = 'admin'"
                ).fetchone()["c"]
                if admins <= 1:
                    raise ValueError("Il doit rester au moins un administrateur.")
            db.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))
    except PermissionError as exc:
        return fail(str(exc), 403)


@app.post("/api/family-code")
@login_required
def regenerate_code(user):
    try:
        require_admin(user)
        with db_conn() as db:
            set_setting(db, "family_code", generate_code())
            payload = tree_payload(db, user)
        return jsonify(payload)
    except ValueError as exc:
        return fail(str(exc))
    except PermissionError as exc:
        return fail(str(exc), 403)


def lan_ip() -> str | None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 1))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def sign_user_id(user_id: int) -> str:
    raw = str(user_id)
    signature = hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()
    return f"{raw}.{signature}"


def unsign_user_id(token: str) -> int | None:
    raw, sep, signature = token.rpartition(".")
    if not sep or not raw.isdigit():
        return None
    expected = hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()
    if not secrets.compare_digest(expected, signature):
        return None
    return int(raw)


def cookie_header() -> str | None:
    current = _local.session
    if not current.dirty:
        return None
    if "user_id" in current:
        token = sign_user_id(int(current["user_id"]))
        return f"racine={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3456000"
    return "racine=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"


def dispatch(method: str, path: str):
    for route_method, pattern, fn in ROUTES:
        if route_method != method:
            continue
        match = pattern.match(path)
        if not match:
            continue
        params = {key: int(value) for key, value in match.groupdict().items()}
        return fn(**params)
    return fail("Introuvable.", 404)


STATIC_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
}


def static_path(url_path: str) -> Path | None:
    if not url_path.startswith("/static/"):
        return None
    relative = unquote(url_path[len("/static/"):])
    if not relative or ".." in relative.split("/"):
        return None
    root = (ROOT / "static").resolve()
    full = (root / relative).resolve()
    if not str(full).startswith(str(root)) or not full.is_file():
        return None
    return full


class RacineHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def do_PATCH(self):
        self.handle_request()

    def do_DELETE(self):
        self.handle_request()

    def log_message(self, fmt, *args):
        if logging.getLogger().isEnabledFor(logging.DEBUG):
            logging.debug("%s - %s", self.address_string(), fmt % args)

    def handle_request(self):
        try:
            self._handle()
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            logging.exception("Erreur inattendue")
            self._send(500, b'{"error":"Une erreur inattendue s\'est produite."}', "application/json; charset=utf-8", None)

    def _handle(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        length = int(self.headers.get("Content-Length") or 0)
        if length > 3_000_000:
            self._send(413, b'{"error":"Message trop volumineux."}', "application/json; charset=utf-8", None)
            return
        raw = self.rfile.read(length) if length else b""
        body = None
        if raw:
            try:
                body = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                body = None
        cookies = SimpleCookie()
        if self.headers.get("Cookie"):
            cookies.load(self.headers.get("Cookie"))
        token = cookies["racine"].value if "racine" in cookies else ""
        user_id = unsign_user_id(token) if token else None
        current = _Session()
        if user_id is not None:
            dict.__setitem__(current, "user_id", user_id)
        _local.session = current
        _local.body = body

        static = static_path(path) if self.command == "GET" else None
        if static:
            content_type = STATIC_TYPES.get(static.suffix, "application/octet-stream")
            self._send(200, static.read_bytes(), content_type, None)
            return
        result = dispatch(self.command, path)
        cookie = cookie_header()
        if isinstance(result, HTML):
            self._send(200, result.text.encode("utf-8"), "text/html; charset=utf-8", cookie)
            return
        if isinstance(result, FileResponse):
            self._send(200, result.data, result.content_type, cookie)
            return
        if isinstance(result, tuple):
            payload, status = result
        else:
            payload, status = result, 200
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, encoded, "application/json; charset=utf-8", cookie)

    def _send(self, status: int, body: bytes, content_type: str, cookie: str | None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)


class RacineServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


init_db()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Lancer Racine, l'arbre de la famille.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    if args.debug:
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.INFO)
    try:
        server = RacineServer((args.host, args.port), RacineHandler)
    except OSError as exc:
        raise SystemExit(f"Impossible d'ouvrir le port {args.port} ({exc}).") from exc
    print("Racine est prêt.")
    print(f"Sur cet ordinateur : http://127.0.0.1:{args.port}")
    if args.host in {"0.0.0.0", "::"}:
        ip = lan_ip()
        if ip:
            print(f"Sur le réseau : http://{ip}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nRacine s'arrête.")
        server.server_close()
