"""Focused regression tests for room access and file handling."""

import atexit
import hashlib
import os
import tempfile
import unittest
from io import BytesIO
from pathlib import Path


TEST_DATA = tempfile.TemporaryDirectory(prefix="sidebyside-tests-")
atexit.register(TEST_DATA.cleanup)
os.environ["DATA_DIR"] = TEST_DATA.name
os.environ["SOPHISTICATED_CODE"] = "test-only-shared-code-9472"
os.environ["FRONTEND_ORIGIN"] = ""

import app as service  # noqa: E402


class RoomServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_data = tempfile.TemporaryDirectory(prefix="sidebyside-case-")
        service.DATA_DIR = Path(self.temp_data.name)
        service.UPLOAD_DIR = service.DATA_DIR / "uploads"
        service.UPLOAD_DIR.mkdir()
        service.VIDEO_INDEX_PATH = service.DATA_DIR / "video_index.sqlite3"
        service.rooms.clear()
        service.initialize_video_index()
        service.app.config.update(TESTING=True)
        self.client = service.app.test_client()
        create = self.client.post(
            "/api/rooms", json={"access_code": "test-only-shared-code-9472"}
        )
        self.assertEqual(create.status_code, 200)
        self.code = create.get_json()["code"]
        self.socket_client = service.socketio.test_client(
            service.app, flask_test_client=self.client
        )
        self.socket_client.emit(
            "join_room",
            {
                "code": self.code,
                "nickname": "Tester",
                "client_id": "test-browser-tab",
                "access_code": "test-only-shared-code-9472",
            },
        )
        received = self.socket_client.get_received()
        joined = next(event["args"][0] for event in received if event["name"] == "joined")
        self.room_token = joined["member_token"]
        self.auth_headers = {"X-Room-Token": self.room_token}

    def tearDown(self):
        self.socket_client.disconnect()
        service.rooms.clear()
        self.temp_data.cleanup()

    def upload(self, name, contents, offer_id=""):
        return self.client.post(
            f"/api/rooms/{self.code}/upload",
            headers=self.auth_headers,
            data={"file": (BytesIO(contents), name), "offer_id": offer_id},
            content_type="multipart/form-data",
        )

    def test_file_routes_reject_requests_without_member_token(self):
        upload = self.client.post(
            f"/api/rooms/{self.code}/upload",
            data={"file": (BytesIO(b"video"), "clip.mp4")},
            content_type="multipart/form-data",
        )
        reuse = self.client.post(
            f"/api/rooms/{self.code}/reuse",
            json={"fingerprint": "0" * 64, "name": "clip.mp4"},
        )
        download = self.client.get(f"/api/rooms/{self.code}/download")
        livekit = self.client.post(
            f"/api/rooms/{self.code}/livekit-token", json={}
        )

        self.assertEqual(upload.status_code, 403)
        self.assertEqual(reuse.status_code, 403)
        self.assertEqual(download.status_code, 403)
        self.assertEqual(livekit.status_code, 403)

    def test_static_page_and_local_scripts_are_served(self):
        for path in ("/", "/app.js", "/config.js", "/styles.css"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                response.close()

    def test_same_origin_socketio_connection_is_allowed_by_default(self):
        browser = service.socketio.test_client(
            service.app,
            flask_test_client=self.client,
            headers={"Origin": "http://localhost"},
        )
        try:
            self.assertTrue(browser.is_connected())
        finally:
            browser.disconnect()

    def test_authorized_upload_can_be_downloaded(self):
        upload = self.upload("clip.mp4", b"small test video contents")
        self.assertEqual(upload.status_code, 200, upload.get_json())
        self.assertTrue(upload.get_json()["available"])

        download = self.client.get(
            f"/api/rooms/{self.code}/download", headers=self.auth_headers
        )
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.data, b"small test video contents")
        download.close()

    def test_refresh_replaces_token_and_invalidates_the_old_one(self):
        refreshed = service.socketio.test_client(
            service.app, flask_test_client=self.client
        )
        refreshed.emit(
            "join_room",
            {
                "code": self.code,
                "nickname": "Tester",
                "client_id": "test-browser-tab",
                "access_code": "test-only-shared-code-9472",
            },
        )
        received = refreshed.get_received()
        joined = next(event["args"][0] for event in received if event["name"] == "joined")
        new_token = joined["member_token"]
        self.assertNotEqual(new_token, self.room_token)
        self.assertNotIn("token", joined["members"][0])

        denied = self.client.post(
            f"/api/rooms/{self.code}/reuse",
            headers=self.auth_headers,
            json={"fingerprint": "0" * 64, "name": "clip.mp4"},
        )
        accepted = self.client.post(
            f"/api/rooms/{self.code}/reuse",
            headers={"X-Room-Token": new_token},
            json={"fingerprint": "0" * 64, "name": "clip.mp4"},
        )
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(accepted.status_code, 200)
        refreshed.disconnect()

    def test_chat_and_playback_updates_reach_other_members(self):
        second = service.socketio.test_client(
            service.app, flask_test_client=self.client
        )
        second.emit(
            "join_room",
            {
                "code": self.code,
                "nickname": "Second",
                "client_id": "second-browser-tab",
                "access_code": "test-only-shared-code-9472",
            },
        )
        second.get_received()

        uploaded = self.upload("clip.mp4", b"watch together")
        self.assertEqual(uploaded.status_code, 200)
        second.get_received()
        file_id = uploaded.get_json()["id"]

        second.emit("chat_send", {"code": self.code, "text": "Hello"})
        chat = next(
            event for event in self.socket_client.get_received()
            if event["name"] == "chat_message"
        )
        self.assertEqual(chat["args"][0]["text"], "Hello")

        self.socket_client.emit(
            "playback",
            {
                "code": self.code,
                "file_id": file_id,
                "paused": False,
                "time": 12.5,
            },
        )
        playback = next(
            event for event in second.get_received()
            if event["name"] == "playback"
        )
        self.assertFalse(playback["args"][0]["paused"])
        self.assertGreaterEqual(playback["args"][0]["time"], 12.5)

        second.emit("playback_sync", {"code": self.code, "file_id": file_id})
        sync = next(
            event for event in second.get_received()
            if event["name"] == "playback"
        )
        self.assertGreaterEqual(sync["args"][0]["time"], 12.5)
        second.disconnect()

    def test_room_chat_file_and_paused_position_survive_process_reload(self):
        uploaded = self.upload("clip.mp4", b"persistent test media")
        self.assertEqual(uploaded.status_code, 200)
        file_id = uploaded.get_json()["id"]
        self.socket_client.emit(
            "playback",
            {
                "code": self.code,
                "file_id": file_id,
                "paused": False,
                "time": 24.0,
            },
        )
        self.socket_client.emit("chat_send", {"code": self.code, "text": "Saved chat"})

        service.rooms.clear()
        service.load_persisted_rooms()
        restored = service.rooms[self.code]

        self.assertEqual(restored["members"], {})
        self.assertEqual(restored["file"]["id"], file_id)
        self.assertTrue(restored["file"]["available"])
        self.assertTrue(restored["playback"]["paused"])
        self.assertGreaterEqual(restored["playback"]["time"], 24.0)
        self.assertEqual(restored["chat_messages"][0]["text"], "Saved chat")

    def test_empty_and_unrecognized_uploads_are_rejected(self):
        empty = self.upload("empty.mp4", b"")
        unrelated = self.upload("notes.txt", b"not media")

        self.assertEqual(empty.status_code, 400)
        self.assertEqual(unrelated.status_code, 415)
        self.assertEqual(list(service.UPLOAD_DIR.iterdir()), [])

    def test_single_member_offer_can_proceed_directly_to_upload(self):
        contents = b"offer flow media"
        chunk_digest = hashlib.sha256(contents).hexdigest()
        fingerprint = hashlib.sha256(
            f"{len(contents)}:{chunk_digest}".encode("ascii")
        ).hexdigest()
        offer = self.socket_client.emit(
            "offer_video",
            {
                "code": self.code,
                "offer_id": "single-member-offer",
                "fingerprint": fingerprint,
                "name": "clip.mp4",
                "size": len(contents),
            },
            callback=True,
        )
        self.assertEqual(offer, {"ok": True, "expected_count": 0})

        upload = self.upload("clip.mp4", contents, "single-member-offer")

        self.assertEqual(upload.status_code, 200, upload.get_json())
        self.assertIsNone(service.rooms[self.code]["pending_offer"])

    def test_storage_quota_rejects_without_leaving_a_partial_file(self):
        previous_limit = service.MAX_STORED_BYTES
        service.MAX_STORED_BYTES = 1
        try:
            response = self.upload("clip.mp4", b"more than one byte")
            self.assertEqual(response.status_code, 507)
            self.assertEqual(list(service.UPLOAD_DIR.iterdir()), [])
        finally:
            service.MAX_STORED_BYTES = previous_limit

    def test_replacing_file_resets_playback_to_new_file(self):
        first = self.upload("first.mp4", b"first media")
        self.assertEqual(first.status_code, 200)
        room = service.rooms[self.code]
        room["playback"] = {
            "paused": False,
            "time": 77.0,
            "file_id": first.get_json()["id"],
            "updated_at": 0,
        }

        second = self.upload("second.mp4", b"second media")

        self.assertEqual(second.status_code, 200)
        playback = room["playback"]
        self.assertTrue(playback["paused"])
        self.assertEqual(playback["time"], 0)
        self.assertEqual(playback["file_id"], second.get_json()["id"])

    def test_incorrect_shared_code_is_rejected_without_blocking_later_attempts(self):
        for _ in range(10):
            response = self.client.post("/api/rooms", json={"access_code": "wrong"})
            self.assertEqual(response.status_code, 403)

        accepted = self.client.post(
            "/api/rooms", json={"access_code": "test-only-shared-code-9472"}
        )
        self.assertEqual(accepted.status_code, 200)

    def test_room_member_limit_is_enforced(self):
        previous_limit = service.MAX_ROOM_MEMBERS
        service.MAX_ROOM_MEMBERS = 1
        extra = service.socketio.test_client(
            service.app, flask_test_client=self.client
        )
        try:
            extra.emit(
                "join_room",
                {
                    "code": self.code,
                    "nickname": "Extra",
                    "client_id": "extra-browser-tab",
                    "access_code": "test-only-shared-code-9472",
                },
            )
            received = extra.get_received()
            error = next(event for event in received if event["name"] == "join_error")
            self.assertIn("full", error["args"][0]["message"])
        finally:
            service.MAX_ROOM_MEMBERS = previous_limit
            extra.disconnect()


if __name__ == "__main__":
    unittest.main()
