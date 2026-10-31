import hashlib
import os
import secrets
import sqlite3
import string
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from livekit import api as livekit_api
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
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
VIDEO_INDEX_PATH = BASE_DIR / "video_index.sqlite3"

app = Flask(__name__, static_folder="web", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024  # 4 GiB initial limit
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", secrets.token_hex(32))

# Set FRONTEND_ORIGIN to the Netlify URL when serving the page separately.
allowed_origins = os.environ.get("FRONTEND_ORIGIN", "*").split(",")
allow_websocket_upgrade = os.environ.get(
    "SOCKETIO_ALLOW_WEBSOCKET", "0"
).lower() in {"1", "true", "yes"}
socketio = SocketIO(
    app,
    cors_allowed_origins=allowed_origins,
    async_mode="threading",
    allow_upgrades=allow_websocket_upgrade,
    max_http_buffer_size=5_000_000,
)


@app.after_request
def add_api_cors_headers(response):
    """Allow the separately hosted website to call this Flask API."""
    if request.path.startswith("/api/"):
        origin = request.headers.get("Origin")
        if "*" in allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = "*"
        elif origin in allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"

        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"

    return response

# This first version keeps room state in memory. Restarting Flask clears rooms.
rooms = {}
CODE_ALPHABET = string.ascii_uppercase + string.digits
FINGERPRINT_CHUNK_SIZE = 8 * 1024 * 1024


@contextmanager
def connect_video_index():
    connection = sqlite3.connect(VIDEO_INDEX_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_video_index():
    with connect_video_index() as connection:
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
        if not path.is_file() or path.name in indexed_names:
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


def make_code():
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
        if code not in rooms:
            return code


def public_members(room):
    return [
        {"id": sid, "nickname": member["nickname"]}
        for sid, member in room["members"].items()
    ]


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.post("/api/rooms")
def create_room():
    code = make_code()
    rooms[code] = {
        "members": {},
        "chat_messages": [],
        "file": None,
        "pending_offer": None,
        "playback": {"paused": True, "time": 0},
    }
    return jsonify({"code": code})


@app.post("/api/rooms/<code>/livekit-token")
def create_livekit_token(code):
    """Issue a short-lived call token to a member already in this watch room."""
    code = code.upper()
    room = rooms.get(code)
    if not room:
        return jsonify({"error": "That room does not exist or has expired."}), 404

    data = request.get_json(silent=True) or {}
    socket_id = str(data.get("socket_id", "")).strip()
    client_id = str(data.get("client_id", "")).strip()
    member = room["members"].get(socket_id)
    if not member or not client_id or member.get("client_id") != client_id:
        return jsonify({"error": "Join the watch room before joining its call."}), 403

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
            .with_ttl(timedelta(hours=6))
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
    room = rooms.get(code)
    if not room:
        return jsonify({"error": "That room does not exist or has expired."}), 404
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify({"error": "Choose a video file first."}), 400
    filename = secure_filename(uploaded.filename) or "video"
    file_id = secrets.token_hex(16)
    stored_name = f"{code}_{file_id}_{filename}"
    stored_path = UPLOAD_DIR / stored_name
    size, fingerprint = save_upload_and_fingerprint(uploaded, stored_path)

    # Keep one server copy for each fingerprint. This also handles two
    # uploads racing to register the same video.
    with connect_video_index() as connection:
        existing = connection.execute(
            "SELECT stored_name FROM videos WHERE fingerprint = ?", (fingerprint,)
        ).fetchone()
        if existing and not (UPLOAD_DIR / existing["stored_name"]).is_file():
            connection.execute(
                "DELETE FROM videos WHERE fingerprint = ?", (fingerprint,)
            )
            existing = None

        if not existing:
            connection.execute(
                "INSERT OR IGNORE INTO videos (fingerprint, stored_name, name, size) VALUES (?, ?, ?, ?)",
                (fingerprint, stored_name, filename, size),
            )
        canonical = connection.execute(
            "SELECT stored_name FROM videos WHERE fingerprint = ?", (fingerprint,)
        ).fetchone()

    if canonical["stored_name"] != stored_name:
        stored_path.unlink(missing_ok=True)
        stored_name = canonical["stored_name"]

    uploader_id = request.form.get("uploader_id", "")
    response = attach_video_to_room(
        code,
        room,
        {
            "fingerprint": fingerprint,
            "name": filename,
            "stored_name": stored_name,
            "size": size,
        },
        uploader_id,
    )
    return jsonify(response)


@app.post("/api/rooms/<code>/reuse")
def reuse_saved_video(code):
    code = code.upper()
    room = rooms.get(code)
    if not room:
        return jsonify({"error": "That room does not exist or has expired."}), 404

    data = request.get_json(silent=True) or {}
    fingerprint = str(data.get("fingerprint", "")).lower()
    if len(fingerprint) != 64 or any(
        character not in "0123456789abcdef" for character in fingerprint
    ):
        return jsonify({"error": "The video file could not be identified."}), 400

    saved_video = find_saved_video(fingerprint)
    if not saved_video:
        return jsonify({"found": False})

    filename = secure_filename(str(data.get("name", ""))) or saved_video["name"]
    uploader_id = str(data.get("uploader_id", ""))
    response = attach_video_to_room(
        code,
        room,
        {
            **saved_video,
            "name": filename,
        },
        uploader_id,
    )
    return jsonify({"found": True, **response})


@app.get("/api/rooms/<code>/download")
def download_video(code):
    room = rooms.get(code.upper())
    if not room or not room.get("file"):
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
def leave_room_on_page_exit(code):
    """Remove a browser tab from its room when it is closing or refreshing."""
    code = code.upper()
    room = rooms.get(code)
    client_id = request.form.get("client_id", "").strip()
    socket_id = request.form.get("socket_id", "").strip()
    if not room or not client_id or not socket_id:
        return "", 204

    removed = False
    for sid, member in list(room["members"].items()):
        if sid == socket_id and member.get("client_id") == client_id:
            del room["members"][sid]
            socketio.server.leave_room(sid, code, namespace="/")
            removed = True

    if removed:
        socketio.emit("members", {"members": public_members(room)}, to=code)
    return "", 204


@socketio.on("connect")
def connected():
    emit("connected", {"ok": True})


@socketio.on("join_room")
def on_join(data):
    code = str((data or {}).get("code", "")).strip().upper()
    nickname = str((data or {}).get("nickname", "")).strip()[:24]
    client_id = str((data or {}).get("client_id", "")).strip()[:100]
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
            del room["members"][old_sid]
            leave_room(code, sid=old_sid)

    join_room(code)
    room["members"][request.sid] = {
        "nickname": nickname,
        "client_id": client_id,
    }
    pending_offer = room.get("pending_offer")
    if pending_offer and request.sid != pending_offer["uploader_id"]:
        pending_offer["expected"].add(request.sid)
    emit(
        "joined",
        {
            "code": code,
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
            "playback": room["playback"],
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
    emit("members", {"members": public_members(room)}, to=code)


@socketio.on("offer_video")
def on_offer_video(data):
    data = data or {}
    code = str(data.get("code", "")).strip().upper()
    room = rooms.get(code)
    fingerprint = str(data.get("fingerprint", "")).lower()
    offer_id = str(data.get("offer_id", ""))[:100]
    if not room or request.sid not in room["members"]:
        return {"ok": False, "error": "You are no longer in this room."}
    if len(fingerprint) != 64 or any(
        character not in "0123456789abcdef" for character in fingerprint
    ):
        return {"ok": False, "error": "The video file could not be identified."}

    try:
        size = max(0, int(data.get("size", 0)))
    except (TypeError, ValueError):
        size = 0

    expected = {sid for sid in room["members"] if sid != request.sid}
    room["pending_offer"] = {
        "id": offer_id,
        "fingerprint": fingerprint,
        "name": secure_filename(str(data.get("name", ""))) or "video",
        "size": size,
        "uploader_id": request.sid,
        "expected": expected,
        "responses": {},
    }
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
def on_video_offer_response(data):
    data = data or {}
    code = str(data.get("code", "")).strip().upper()
    room = rooms.get(code)
    offer = room.get("pending_offer") if room else None
    if (
        not offer
        or offer["id"] != str(data.get("offer_id", ""))
        or request.sid not in offer["expected"]
    ):
        return

    offer["responses"][request.sid] = bool(data.get("has_file"))
    have_count = sum(offer["responses"].values())
    need_count = len(offer["responses"]) - have_count
    all_responded = len(offer["responses"]) == len(offer["expected"])

    if all_responded and need_count == 0:
        room["file"] = {
            "id": offer["id"],
            "fingerprint": offer["fingerprint"],
            "name": offer["name"],
            "stored_name": None,
            "size": offer["size"],
            "available": False,
        }
        room["pending_offer"] = None

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
def on_leave(data):
    code = str((data or {}).get("code", "")).strip().upper()
    room = rooms.get(code)
    if room and request.sid in room["members"]:
        del room["members"][request.sid]
        leave_room(code)
        emit("members", {"members": public_members(room)}, to=code)


@socketio.on("playback")
def on_playback(data):
    code = str((data or {}).get("code", "")).strip().upper()
    room = rooms.get(code)
    if not room or request.sid not in room["members"]:
        return
    paused = bool((data or {}).get("paused", True))
    try:
        position = max(0.0, float((data or {}).get("time", 0)))
    except (TypeError, ValueError):
        position = 0.0
    room["playback"] = {"paused": paused, "time": position}
    emit("playback", room["playback"], to=code, include_self=False)


@socketio.on("chat_send")
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
    socketio.emit("chat_message", message, to=code)
    return {"ok": True}


@socketio.on("disconnect")
def on_disconnect():
    for code, room in list(rooms.items()):
        if request.sid in room["members"]:
            del room["members"][request.sid]
            emit("members", {"members": public_members(room)}, to=code)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        debug=True,
        allow_unsafe_werkzeug=True,
        load_dotenv=False,
    )
