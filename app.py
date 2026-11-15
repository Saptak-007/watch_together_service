import hashlib
import json
import math
import mimetypes
import os
import secrets
import sqlite3
import string
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from livekit import api as livekit_api
from werkzeug.exceptions import HTTPException
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent


def load_environment_file(path):
    """Load simple NAME=value settings, without replacing OS environment values."""
    if not path.is_file():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if name.isidentifier():
            os.environ.setdefault(name, value)


load_environment_file(BASE_DIR / ".env")
DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR))).expanduser().resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
VIDEO_INDEX_PATH = DATA_DIR / "video_index.sqlite3"


def positive_int_setting(name, default):
    try:
        return max(1, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


MAX_UPLOAD_BYTES = positive_int_setting("MAX_UPLOAD_BYTES", 1024 * 1024 * 1024)
MAX_STORED_BYTES = positive_int_setting("MAX_STORED_BYTES", 10 * 1024 * 1024 * 1024)
ROOM_EMPTY_TTL_SECONDS = positive_int_setting("ROOM_EMPTY_TTL_SECONDS", 30 * 60)
MAX_ROOM_MEMBERS = positive_int_setting("MAX_ROOM_MEMBERS", 20)

app = Flask(__name__, static_folder="web", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES + 1024 * 1024
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or secrets.token_hex(32)

# Set FRONTEND_ORIGIN to the Netlify URL when serving the page separately.
allowed_origins = [
    origin.strip().rstrip("/")
    for origin in os.environ.get("FRONTEND_ORIGIN", "").split(",")
    if origin.strip()
]
allow_websocket_upgrade = os.environ.get(
    "SOCKETIO_ALLOW_WEBSOCKET", "0"
).lower() in {"1", "true", "yes"}
socketio = SocketIO(
    app,
    cors_allowed_origins=allowed_origins or None,
    async_mode="threading",
    allow_upgrades=allow_websocket_upgrade,
    max_http_buffer_size=5_000_000,
)


@app.after_request
def add_api_cors_headers(response):
    """Allow the separately hosted website to call this Flask API."""
    if request.path.startswith("/api/"):
        origin = request.headers.get("Origin")
        if origin and ("*" in allowed_origins or origin.rstrip("/") in allowed_origins):
            response.headers["Access-Control-Allow-Origin"] = (
                "*" if "*" in allowed_origins else origin
            )
        if origin and origin.rstrip("/") in allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"

        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Room-Token"

        response.headers["Cache-Control"] = "no-store"

    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")

    return response

# Room membership and pending offers are live process state; durable room data
# is loaded from the SQLite database below.
rooms = {}
ROOMS_LOCK = threading.RLock()
CODE_ALPHABET = string.ascii_uppercase + string.digits
FINGERPRINT_CHUNK_SIZE = 8 * 1024 * 1024
UPLOAD_LOCK = threading.Lock()


def serialized_room_state(function):
    """Protect shared in-process room updates when threaded requests overlap."""
    @wraps(function)
    def wrapped(*args, **kwargs):
        with ROOMS_LOCK:
            return function(*args, **kwargs)

    return wrapped


@contextmanager
def connect_video_index():
    connection = sqlite3.connect(VIDEO_INDEX_PATH, timeout=30)
    connection.execute("PRAGMA busy_timeout = 30000")
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_video_index():
    with connect_video_index() as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS videos (
                fingerprint TEXT PRIMARY KEY,
                stored_name TEXT NOT NULL,
                name TEXT NOT NULL,
                size INTEGER NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS rooms (
                code TEXT PRIMARY KEY,
                file_json TEXT,
                playback_json TEXT NOT NULL,
                chat_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                empty_since REAL
            )
            """
        )


initialize_video_index()


def find_saved_video(fingerprint):
    with connect_video_index() as connection:
        row = connection.execute(
            "SELECT fingerprint, stored_name, name, size FROM videos WHERE fingerprint = ?",
            (fingerprint,),
        ).fetchone()
        if not row:
            return None

        saved_video = dict(row)
        if (UPLOAD_DIR / saved_video["stored_name"]).is_file():
            return saved_video

        connection.execute(
            "DELETE FROM videos WHERE fingerprint = ?", (fingerprint,)
        )
        return None


@serialized_room_state
def persist_room(code, room):
    with connect_video_index() as connection:
        connection.execute(
            """
            INSERT INTO rooms (code, file_json, playback_json, chat_json, created_at, empty_since)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                file_json = excluded.file_json,
                playback_json = excluded.playback_json,
                chat_json = excluded.chat_json,
                created_at = excluded.created_at,
                empty_since = excluded.empty_since
            """,
            (
                code,
                json.dumps(room["file"]),
                json.dumps(room["playback"]),
                json.dumps(room["chat_messages"]),
                room["created_at"],
                room["empty_since"],
            ),
        )


def load_persisted_rooms():
    now = time.time()
    with connect_video_index() as connection:
        rows = connection.execute(
            "SELECT code, file_json, playback_json, chat_json, created_at, empty_since FROM rooms"
        ).fetchall()

    for row in rows:
        try:
            saved_empty_since = row["empty_since"]
            if (
                saved_empty_since
                and now - saved_empty_since >= ROOM_EMPTY_TTL_SECONDS
            ):
                with connect_video_index() as connection:
                    connection.execute("DELETE FROM rooms WHERE code = ?", (row["code"],))
                continue
            file_info = json.loads(row["file_json"]) if row["file_json"] else None
            playback = json.loads(row["playback_json"])
            chat_messages = json.loads(row["chat_json"])
            if file_info and file_info.get("available", True):
                stored_name = file_info.get("stored_name")
                if not stored_name or not (UPLOAD_DIR / stored_name).is_file():
                    file_info["available"] = False
                    file_info["stored_name"] = None
            playback["paused"] = True
            playback.setdefault("playback_rate", 1)
            playback["updated_at"] = now
            rooms[row["code"]] = {
                "members": {},
                "chat_messages": chat_messages[-200:],
                "file": file_info,
                "pending_offer": None,
                "playback": playback,
                "created_at": row["created_at"],
                "empty_since": saved_empty_since or now,
            }
            persist_room(row["code"], rooms[row["code"]])
        except (TypeError, ValueError, json.JSONDecodeError, KeyError):
            app.logger.warning("Skipping an invalid saved room record")


@serialized_room_state
def attach_video_to_room(code, room, file_info, uploader_id):
    file_id = secrets.token_hex(16)
    room["file"] = {
        "id": file_id,
        "fingerprint": file_info["fingerprint"],
        "name": file_info["name"],
        "stored_name": file_info["stored_name"],
        "size": file_info["size"],
        "available": True,
    }
    room["pending_offer"] = None
    room["playback"] = {
        "paused": True,
        "time": 0,
        "playback_rate": 1,
        "file_id": file_id,
        "updated_at": time.time(),
    }
    socketio.emit(
        "file_available",
        {
            "id": file_id,
            "fingerprint": file_info["fingerprint"],
            "name": file_info["name"],
            "size": file_info["size"],
            "available": True,
            "uploader_id": uploader_id,
        },
        to=code,
    )
    socketio.emit("playback", playback_snapshot(room), to=code)
    return {
        "id": file_id,
        "fingerprint": file_info["fingerprint"],
        "name": file_info["name"],
        "size": file_info["size"],
        "available": True,
    }


def save_upload_and_fingerprint(uploaded, destination):
    chunk_hashes = []
    size = 0
    with destination.open("wb") as output:
        while chunk := uploaded.stream.read(FINGERPRINT_CHUNK_SIZE):
            output.write(chunk)
            size += len(chunk)
            chunk_hashes.append(hashlib.sha256(chunk).hexdigest())

    fingerprint_input = f"{size}:{':'.join(chunk_hashes)}".encode("ascii")
    fingerprint = hashlib.sha256(fingerprint_input).hexdigest()
    return size, fingerprint


def fingerprint_saved_file(path):
    chunk_hashes = []
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(FINGERPRINT_CHUNK_SIZE):
            size += len(chunk)
            chunk_hashes.append(hashlib.sha256(chunk).hexdigest())

    fingerprint_input = f"{size}:{':'.join(chunk_hashes)}".encode("ascii")
    return hashlib.sha256(fingerprint_input).hexdigest(), size


def index_existing_uploads():
    """Record old uploads too, so they can be reused after this update."""
    with connect_video_index() as connection:
        indexed_names = {
            row[0] for row in connection.execute("SELECT stored_name FROM videos")
        }

    for path in UPLOAD_DIR.iterdir():
        if path.is_file() and path.name.startswith(".") and path.name.endswith(".uploading"):
            try:
                if time.time() - path.stat().st_mtime > 60 * 60:
                    path.unlink(missing_ok=True)
            except OSError:
                continue
        if (
            not path.is_file()
            or path.name.startswith(".")
            or path.name.endswith(".uploading")
            or path.name in indexed_names
        ):
            continue

        try:
            fingerprint, size = fingerprint_saved_file(path)
            with connect_video_index() as connection:
                connection.execute(
                    "INSERT OR IGNORE INTO videos (fingerprint, stored_name, name, size) VALUES (?, ?, ?, ?)",
                    (fingerprint, path.name, path.name, size),
                )
        except OSError:
            # Ignore an upload that is currently being written or removed.
            continue


index_existing_uploads()
load_persisted_rooms()


def make_code():
    cleanup_expired_rooms()
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
        if code not in rooms:
            return code


@serialized_room_state
def cleanup_expired_rooms():
    now = time.time()
    for code, room in list(rooms.items()):
        empty_since = room.get("empty_since")
        if not room["members"] and empty_since and now - empty_since >= ROOM_EMPTY_TTL_SECONDS:
            rooms.pop(code, None)
            with connect_video_index() as connection:
                connection.execute("DELETE FROM rooms WHERE code = ?", (code,))


def check_access_code(provided_code):
    expected_code = os.environ.get("SOPHISTICATED_CODE", "").strip()
    if not expected_code:
        return (
            "Room access is not configured on the server. Set SOPHISTICATED_CODE.",
            503,
        )

    provided_code = str(provided_code or "").strip()
    if not secrets.compare_digest(provided_code, expected_code):
        return "The shared access code is incorrect.", 403
    return None


@serialized_room_state
def authenticated_member(code):
    room = rooms.get(code.upper())
    if not room:
        return None
    token = (
        request.headers.get("X-Room-Token")
        or request.form.get("room_token", "")
    ).strip()
    if not token and request.is_json:
        data = request.get_json(silent=True) or {}
        token = str(data.get("room_token", "")).strip()
    if not token:
        return None
    if len(token) > 128:
        return None
    token_bytes = token.encode("utf-8")
    for sid, member in room["members"].items():
        stored_token = member.get("token", "").encode("utf-8")
        if stored_token and secrets.compare_digest(token_bytes, stored_token):
            return room, sid, member
    return None


@serialized_room_state
def remove_member(code, room, sid):
    member = room["members"].pop(sid, None)
    if not member:
        return False
    socketio.server.leave_room(sid, code, namespace="/")
    offer = room.get("pending_offer")
    if offer and offer["uploader_id"] == sid:
        room["pending_offer"] = None
        offer = None
    if offer and sid in offer["expected"]:
        offer["expected"].discard(sid)
        offer["responses"].pop(sid, None)
        expected_count = len(offer["expected"])
        have_count = sum(offer["responses"].values())
        need_count = sum(not value for value in offer["responses"].values())
        all_responded = expected_count > 0 and len(offer["responses"]) == expected_count
        if offer["uploader_id"] in room["members"]:
            socketio.emit(
                "video_offer_progress",
                {
                    "offer_id": offer["id"],
                    "have_count": have_count,
                    "need_count": need_count if all_responded else (1 if not expected_count else need_count),
                    "all_responded": all_responded or not expected_count,
                },
                to=offer["uploader_id"],
            )
    if not room["members"]:
        room["empty_since"] = time.time()
    persist_room(code, room)
    return True


@serialized_room_state
def live_pending_offer(room):
    offer = room.get("pending_offer")
    if offer and time.monotonic() - offer.get("created_at", 0) > 45:
        room["pending_offer"] = None
        return None
    return offer


@serialized_room_state
def playback_snapshot(room):
    state = dict(room["playback"])
    state.setdefault("playback_rate", 1)
    if not state.get("paused"):
        elapsed = max(0.0, time.time() - state.get("updated_at", time.time()))
        state["time"] += elapsed * state["playback_rate"]
    return state


@serialized_room_state
def public_members(room):
    return [
        {"id": sid, "nickname": member["nickname"]}
        for sid, member in room["members"].items()
    ]


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.post("/api/rooms")
@serialized_room_state
def create_room():
    data = request.get_json(silent=True) or {}
    access_error = check_access_code(data.get("access_code"))
    if access_error:
        return jsonify({"error": access_error[0]}), access_error[1]

    code = make_code()
    created_at = time.time()
    rooms[code] = {
        "members": {},
        "chat_messages": [],
        "file": None,
        "pending_offer": None,
        "playback": {
            "paused": True,
            "time": 0,
            "playback_rate": 1,
            "file_id": None,
            "updated_at": created_at,
        },
        "created_at": created_at,
        "empty_since": created_at,
    }
    persist_room(code, rooms[code])
    return jsonify({"code": code})


@app.post("/api/rooms/<code>/livekit-token")
@serialized_room_state
def create_livekit_token(code):
    """Issue a short-lived call token to a member already in this watch room."""
    code = code.upper()
    authenticated = authenticated_member(code)
    if not authenticated:
        if code not in rooms:
            return jsonify({"error": "That room does not exist or has expired."}), 404
        return jsonify({"error": "Join the watch room before joining its call."}), 403
    _room, _sid, member = authenticated

    livekit_url = os.environ.get("LIVEKIT_URL", "").strip()
    api_key = os.environ.get("LIVEKIT_API_KEY", "").strip()
    api_secret = os.environ.get("LIVEKIT_API_SECRET", "").strip()
    if not livekit_url or not api_key or not api_secret:
        return jsonify(
            {
                "error": "The video call is not configured yet. Add the LiveKit settings to the Flask server."
            }
        ), 503
    if not livekit_url.startswith("wss://"):
        return jsonify({"error": "The LiveKit server address must start with wss://."}), 503

    identity = f"participant_{secrets.token_hex(16)}"
    try:
        token = (
            livekit_api.AccessToken(api_key, api_secret)
            .with_identity(identity)
            .with_name(member["nickname"])
            .with_ttl(timedelta(minutes=10))
            .with_grants(
                livekit_api.VideoGrants(
                    room_join=True,
                    room=code,
                    can_publish=True,
                    can_subscribe=True,
                    can_publish_data=False,
                )
            )
            .to_jwt()
        )
    except Exception:
        app.logger.exception("Could not create a LiveKit participant token")
        return jsonify({"error": "Could not prepare the video call. Try again."}), 500

    return jsonify({"server_url": livekit_url, "participant_token": token})


@app.post("/api/rooms/<code>/upload")
def upload_video(code):
    code = code.upper()
    authenticated = authenticated_member(code)
    if not authenticated:
        if code not in rooms:
            return jsonify({"error": "That room does not exist or has expired."}), 404
        return jsonify({"error": "Join this room before adding a video."}), 403
    room, uploader_id, _member = authenticated
    pending_offer = live_pending_offer(room)
    if pending_offer and pending_offer["uploader_id"] != uploader_id:
        return jsonify({"error": "Another member is already adding a video."}), 409
    offer_id = request.form.get("offer_id", "")[:100]
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify({"error": "Choose an audio or video file first."}), 400
    filename = secure_filename(uploaded.filename)[:180] or "media-file"
    declared_type = (uploaded.mimetype or "").lower()
    guessed_type = mimetypes.guess_type(filename)[0] or ""
    if not (
        declared_type.startswith(("audio/", "video/"))
        or guessed_type.startswith(("audio/", "video/"))
    ):
        return jsonify({"error": "Choose a file recognized as audio or video."}), 415

    file_id = secrets.token_hex(16)
    stored_name = f"{code}_{file_id}_{filename}"
    stored_path = UPLOAD_DIR / stored_name
    temporary_path = UPLOAD_DIR / f".{file_id}.uploading"
    try:
        size, fingerprint = save_upload_and_fingerprint(uploaded, temporary_path)
        if size == 0:
            temporary_path.unlink(missing_ok=True)
            return jsonify({"error": "The selected file is empty."}), 400
        if size > MAX_UPLOAD_BYTES:
            temporary_path.unlink(missing_ok=True)
            return jsonify(
                {"error": f"Files must be {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB or smaller."}
            ), 413

        # Serialize registration so duplicate uploads in this process cannot
        # point the index at a file that has not been moved into place yet.
        with UPLOAD_LOCK:
            with connect_video_index() as connection:
                existing = connection.execute(
                    "SELECT stored_name FROM videos WHERE fingerprint = ?", (fingerprint,)
                ).fetchone()
            if existing and (UPLOAD_DIR / existing["stored_name"]).is_file():
                temporary_path.unlink(missing_ok=True)
                stored_name = existing["stored_name"]
            else:
                if existing:
                    with connect_video_index() as connection:
                        connection.execute(
                            "DELETE FROM videos WHERE fingerprint = ?", (fingerprint,)
                        )
                stored_bytes = sum(
                    path.stat().st_size
                    for path in UPLOAD_DIR.iterdir()
                    if path.is_file() and not path.name.startswith(".")
                )
                if stored_bytes + size > MAX_STORED_BYTES:
                    temporary_path.unlink(missing_ok=True)
                    return jsonify(
                        {"error": "The server’s video storage is full. Ask its owner to free space."}
                    ), 507
                os.replace(temporary_path, stored_path)
                try:
                    with connect_video_index() as connection:
                        connection.execute(
                            "INSERT OR IGNORE INTO videos (fingerprint, stored_name, name, size) VALUES (?, ?, ?, ?)",
                            (fingerprint, stored_name, filename, size),
                        )
                        canonical = connection.execute(
                            "SELECT stored_name FROM videos WHERE fingerprint = ?", (fingerprint,)
                        ).fetchone()
                    if canonical and canonical["stored_name"] != stored_name:
                        stored_path.unlink(missing_ok=True)
                        stored_name = canonical["stored_name"]
                except Exception:
                    stored_path.unlink(missing_ok=True)
                    raise
    except OSError:
        temporary_path.unlink(missing_ok=True)
        app.logger.exception("Could not save uploaded media")
        return jsonify(
            {"error": "The server could not save this file. Check available storage."}
        ), 500
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise

    with ROOMS_LOCK:
        authenticated = authenticated_member(code)
        if not authenticated:
            return jsonify({"error": "Your room session ended before the upload finished."}), 403
        room, current_uploader_id, _member = authenticated
        pending_offer = live_pending_offer(room)
        if pending_offer and (
            pending_offer["uploader_id"] != current_uploader_id
            or pending_offer["id"] != offer_id
            or pending_offer["fingerprint"] != fingerprint
        ):
            return jsonify({"error": "Another member is already adding a different video."}), 409
        response = attach_video_to_room(
            code,
            room,
            {
                "fingerprint": fingerprint,
                "name": filename,
                "stored_name": stored_name,
                "size": size,
            },
            current_uploader_id,
        )
    return jsonify(response)


@app.post("/api/rooms/<code>/reuse")
@serialized_room_state
def reuse_saved_video(code):
    code = code.upper()
    authenticated = authenticated_member(code)
    if not authenticated:
        if code not in rooms:
            return jsonify({"error": "That room does not exist or has expired."}), 404
        return jsonify({"error": "Join this room before adding a video."}), 403
    room, uploader_id, _member = authenticated
    if live_pending_offer(room):
        return jsonify({"error": "Wait until the current video check is finished."}), 409

    data = request.get_json(silent=True) or {}
    fingerprint = str(data.get("fingerprint", "")).lower()
    if len(fingerprint) != 64 or any(
        character not in "0123456789abcdef" for character in fingerprint
    ):
        return jsonify({"error": "The video file could not be identified."}), 400

    saved_video = find_saved_video(fingerprint)
    if not saved_video:
        return jsonify({"found": False})

    filename = secure_filename(str(data.get("name", "")))[:180] or saved_video["name"]
    authenticated = authenticated_member(code)
    if not authenticated:
        return jsonify({"error": "Your room session ended before the video was added."}), 403
    room, uploader_id, _member = authenticated
    if live_pending_offer(room):
        return jsonify({"error": "Wait until the current video check is finished."}), 409
    response = attach_video_to_room(
        code, room, {**saved_video, "name": filename}, uploader_id
    )
    return jsonify({"found": True, **response})


@app.get("/api/rooms/<code>/download")
@serialized_room_state
def download_video(code):
    authenticated = authenticated_member(code)
    if not authenticated:
        if code.upper() not in rooms:
            return jsonify({"error": "That room does not exist or has expired."}), 404
        return jsonify({"error": "Join this room before downloading its video."}), 403
    room, _sid, _member = authenticated
    if not room.get("file"):
        return jsonify({"error": "No video is available in this room."}), 404
    file_info = room["file"]
    if not file_info.get("available", True):
        return jsonify(
            {
                "error": "No server copy is available yet. Ask the person who added the video to upload it."
            }
        ), 409
    return send_from_directory(
        UPLOAD_DIR,
        file_info["stored_name"],
        as_attachment=True,
        download_name=file_info["name"],
    )


@app.post("/api/rooms/<code>/leave")
@serialized_room_state
def leave_room_on_page_exit(code):
    """Remove the authenticated browser tab when it closes or refreshes."""
    code = code.upper()
    authenticated = authenticated_member(code)
    if authenticated:
        room, sid, _member = authenticated
        remove_member(code, room, sid)
        socketio.emit("members", {"members": public_members(room)}, to=code)
    return "", 204


@app.errorhandler(413)
def request_entity_too_large(_error):
    return jsonify(
        {"error": f"Files must be {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB or smaller."}
    ), 413


@app.errorhandler(Exception)
def handle_unexpected_http_error(error):
    if isinstance(error, HTTPException):
        return error
    app.logger.exception("Unhandled HTTP request error")
    return jsonify({"error": "The server hit an unexpected problem. Please try again."}), 500


@socketio.on("connect")
def connected():
    emit("connected", {"ok": True})


@socketio.on("join_room")
@serialized_room_state
def on_join(data):
    data = data or {}
    cleanup_expired_rooms()
    access_error = check_access_code(data.get("access_code"))
    if access_error:
        emit("join_error", {"message": access_error[0]})
        return

    code = str(data.get("code", "")).strip().upper()
    nickname = str(data.get("nickname", "")).strip()[:24]
    client_id = str(data.get("client_id", "")).strip()[:100]
    room = rooms.get(code)
    if not room:
        emit(
            "join_error",
            {"message": "Room code not found. Check the code and try again."},
        )
        return
    if not nickname:
        emit("join_error", {"message": "Enter a nickname to join."})
        return

    # A page refresh creates a new Socket.IO session ID. Replace any prior
    # session from this browser tab so the member list does not show duplicates.
    if client_id:
        old_sids = [
            sid
            for sid, member in room["members"].items()
            if member.get("client_id") == client_id
        ]
        for old_sid in old_sids:
            remove_member(code, room, old_sid)

    if request.sid not in room["members"] and len(room["members"]) >= MAX_ROOM_MEMBERS:
        emit("join_error", {"message": "This room is full. Ask the creator to try again later."})
        return

    join_room(code)
    member_token = secrets.token_urlsafe(32)
    room["members"][request.sid] = {
        "nickname": nickname,
        "client_id": client_id,
        "token": member_token,
    }
    room["empty_since"] = None
    pending_offer = live_pending_offer(room)
    if pending_offer and request.sid != pending_offer["uploader_id"]:
        pending_offer["expected"].add(request.sid)
    emit(
        "joined",
        {
            "code": code,
            "member_token": member_token,
            "members": public_members(room),
            "file": (
                {
                    "id": room["file"]["id"],
                    "fingerprint": room["file"]["fingerprint"],
                    "name": room["file"]["name"],
                    "size": room["file"]["size"],
                    "available": room["file"].get("available", True),
                }
                if room["file"]
                else None
            ),
            "playback": playback_snapshot(room),
            "chat_messages": room["chat_messages"],
        },
    )
    if pending_offer and request.sid != pending_offer["uploader_id"]:
        socketio.emit(
            "video_offer",
            {
                "offer_id": pending_offer["id"],
                "fingerprint": pending_offer["fingerprint"],
                "name": pending_offer["name"],
                "size": pending_offer["size"],
            },
            to=request.sid,
        )
    persist_room(code, room)
    emit("members", {"members": public_members(room)}, to=code)


@socketio.on("offer_video")
@serialized_room_state
def on_offer_video(data):
    data = data or {}
    code = str(data.get("code", "")).strip().upper()
    room = rooms.get(code)
    fingerprint = str(data.get("fingerprint", "")).lower()
    offer_id = str(data.get("offer_id", ""))[:100]
    if not room or request.sid not in room["members"]:
        return {"ok": False, "error": "You are no longer in this room."}
    if live_pending_offer(room):
        return {"ok": False, "error": "Another video check is already in progress."}
    if len(fingerprint) != 64 or any(
        character not in "0123456789abcdef" for character in fingerprint
    ):
        return {"ok": False, "error": "The video file could not be identified."}

    try:
        size = int(data.get("size", 0))
    except (TypeError, ValueError):
        return {"ok": False, "error": "The video size could not be read."}
    if size <= 0 or size > MAX_UPLOAD_BYTES:
        return {
            "ok": False,
            "error": f"Choose a file smaller than {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB.",
        }

    expected = {sid for sid in room["members"] if sid != request.sid}
    room["pending_offer"] = {
        "id": offer_id,
        "fingerprint": fingerprint,
        "name": secure_filename(str(data.get("name", "")))[:180] or "media-file",
        "size": size,
        "uploader_id": request.sid,
        "expected": expected,
        "responses": {},
        "created_at": time.monotonic(),
    }
    if expected:
        socketio.emit(
            "video_offer",
            {
                "offer_id": offer_id,
                "fingerprint": fingerprint,
                "name": room["pending_offer"]["name"],
                "size": size,
            },
            to=code,
            include_self=False,
        )
    return {"ok": True, "expected_count": len(expected)}


@socketio.on("video_offer_response")
@serialized_room_state
def on_video_offer_response(data):
    data = data or {}
    code = str(data.get("code", "")).strip().upper()
    room = rooms.get(code)
    offer = live_pending_offer(room) if room else None
    if (
        not offer
        or offer["id"] != str(data.get("offer_id", ""))
        or request.sid not in offer["expected"]
    ):
        return

    if not isinstance(data.get("has_file"), bool):
        return

    offer["responses"][request.sid] = data["has_file"]
    have_count = sum(offer["responses"].values())
    need_count = len(offer["responses"]) - have_count
    all_responded = len(offer["responses"]) == len(offer["expected"])

    if all_responded and need_count == 0:
        file_id = offer["id"]
        room["file"] = {
            "id": file_id,
            "fingerprint": offer["fingerprint"],
            "name": offer["name"],
            "stored_name": None,
            "size": offer["size"],
            "available": False,
        }
        room["pending_offer"] = None
        room["playback"] = {
            "paused": True,
            "time": 0,
            "playback_rate": 1,
            "file_id": file_id,
            "updated_at": time.time(),
        }
        socketio.emit("playback", playback_snapshot(room), to=code)
        persist_room(code, room)
    persist_room(code, room)

    socketio.emit(
        "video_offer_progress",
        {
            "offer_id": offer["id"],
            "have_count": have_count,
            "need_count": need_count,
            "all_responded": all_responded,
        },
        to=offer["uploader_id"],
    )


@socketio.on("leave_room")
@serialized_room_state
def on_leave(data):
    code = str((data or {}).get("code", "")).strip().upper()
    room = rooms.get(code)
    if room and request.sid in room["members"]:
        remove_member(code, room, request.sid)
        emit("members", {"members": public_members(room)}, to=code)


@socketio.on("playback")
@serialized_room_state
def on_playback(data):
    code = str((data or {}).get("code", "")).strip().upper()
    room = rooms.get(code)
    if not room or request.sid not in room["members"]:
        return
    data = data or {}
    current_file_id = room["file"]["id"] if room.get("file") else None
    if data.get("file_id") != current_file_id:
        return
    paused = bool(data.get("paused", True))
    try:
        position = float(data.get("time", 0))
    except (TypeError, ValueError):
        return
    if not math.isfinite(position) or position < 0:
        return
    try:
        playback_rate = float(
            data.get("playback_rate", room["playback"].get("playback_rate", 1))
        )
    except (TypeError, ValueError):
        return
    if not math.isfinite(playback_rate) or not 0.25 <= playback_rate <= 4:
        return
    room["playback"] = {
        "paused": paused,
        "time": position,
        "playback_rate": playback_rate,
        "file_id": current_file_id,
        "updated_at": time.time(),
    }
    persist_room(code, room)
    emit("playback", playback_snapshot(room), to=code, include_self=False)


@socketio.on("playback_resync")
@serialized_room_state
def on_playback_resync(data):
    data = data or {}
    code = str(data.get("code", "")).strip().upper()
    room = rooms.get(code)
    if (
        not room
        or request.sid not in room["members"]
        or not room.get("file")
        or data.get("file_id") != room["file"]["id"]
    ):
        return
    state = playback_snapshot(room)
    state["resync"] = True
    socketio.emit("playback", state, to=code)


@socketio.on("playback_sync")
@serialized_room_state
def on_playback_sync(data):
    data = data or {}
    code = str(data.get("code", "")).strip().upper()
    room = rooms.get(code)
    if (
        not room
        or request.sid not in room["members"]
        or not room.get("file")
        or data.get("file_id") != room["file"]["id"]
    ):
        return
    emit("playback", playback_snapshot(room), to=request.sid)


@socketio.on("chat_send")
@serialized_room_state
def on_chat_send(data):
    data = data or {}
    code = str(data.get("code", "")).strip().upper()
    room = rooms.get(code)
    member = room["members"].get(request.sid) if room else None
    if not member:
        return {"ok": False, "error": "Join the room before sending a message."}

    text = str(data.get("text", "")).strip()
    if not text:
        return {"ok": False, "error": "Type a message first."}
    if len(text) > 1000:
        return {"ok": False, "error": "Messages must be 1,000 characters or fewer."}

    message = {
        "nickname": member["nickname"],
        "text": text,
        "sent_at": datetime.now(timezone.utc).isoformat(),
    }
    room["chat_messages"].append(message)
    del room["chat_messages"][:-200]
    persist_room(code, room)
    socketio.emit("chat_message", message, to=code)
    return {"ok": True}


@socketio.on("disconnect")
@serialized_room_state
def on_disconnect():
    for code, room in list(rooms.items()):
        if request.sid in room["members"]:
            remove_member(code, room, request.sid)
            emit("members", {"members": public_members(room)}, to=code)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        debug=os.environ.get("FLASK_DEBUG", "0").lower() in {"1", "true", "yes"},
        allow_unsafe_werkzeug=True,
        load_dotenv=False,
    )
