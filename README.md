# SideBySide

SideBySide is a watch-together learning project built with Flask (Python),
Flask-SocketIO, and plain HTML, CSS, and JavaScript. People join a room with a
room code and a shared access code. They can chat, share a local audio or video
file, and synchronize playback. Camera and microphone calls use LiveKit Cloud.

The Socket.IO browser client and LiveKit browser client are stored in
`web/vendor`, so loading the application scripts does not require a JavaScript
CDN. The page uses system fonts and does not fetch fonts from a third party.

## Run locally

1. Install Python 3.10 or newer.
2. From this folder, create and activate a virtual environment, then install
   the requirements:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   ```

3. Edit `.env`. Set `SOPHISTICATED_CODE` to a long private shared code. Set
   `A_CODE` to the admin codes, grouped by authority. For example,
   `A_CODE=admin_code_1.admin_code_2=admin_code_3` makes `admin_code_1` highest authority and `admin_code_2` and `admin_code_3`
   equal at the next level. The first three individual codes count toward the
   `cse_core_team assembled` room announcement. An admin code is released as
   soon as its user leaves, closes the tab, or disconnects. Add the LiveKit URL,
   API key, and API secret if you want to use the camera call.
4. Start Flask and open http://127.0.0.1:5000:

   ```powershell
   py app.py
   ```

Debug mode is off by default. Set `FLASK_DEBUG=1` only for local development.
The Flask development server is not intended for public hosting. A Cloudflare
Tunnel can expose your computer while you test, but anyone who can reach the
address can reach the Flask server; keep the tunnel private and stop it when
you finish testing.

## Configuration

`.env.example` lists the supported settings. Copy it to `.env` for local use;
real `.env` files are ignored by Git. On a host such as Render, add the same
settings in its Environment page rather than uploading `.env`.

| Setting | Purpose | Default |
| --- | --- | --- |
| `SOPHISTICATED_CODE` | Shared code required to create or join a room | Required |
| `A_CODE` | Admin access codes: `.` separates authority levels; `=` means equal level | Optional |
| `LIVEKIT_URL` | LiveKit Cloud WebSocket address | Call feature disabled if missing |
| `LIVEKIT_API_KEY` | Server-side LiveKit API key | Call feature disabled if missing |
| `LIVEKIT_API_SECRET` | Server-side LiveKit API secret | Call feature disabled if missing |
| `FRONTEND_ORIGIN` | Allowed browser origins, comma-separated | Same-origin only |
| `DATA_DIR` | Folder for uploads and the SQLite video index | Project folder |
| `MAX_UPLOAD_BYTES` | Maximum uploaded file size in bytes | 1 GiB |
| `MAX_STORED_BYTES` | Maximum combined size of saved server-side media files | 10 GiB |
| `ROOM_EMPTY_TTL_SECONDS` | How long an empty room stays available for refresh/rejoin | 1,800 seconds |
| `MAX_ROOM_MEMBERS` | Maximum connected people in one room | 20 |
| `SOCKETIO_ALLOW_WEBSOCKET` | Allow polling connections to upgrade to WebSocket | Off |
| `FLASK_DEBUG` | Enable Flask’s development debugger | Off |

For a Netlify frontend, set `FRONTEND_ORIGIN` to the exact Netlify site origin,
for example `https://your-site.netlify.app`. If you have more than one frontend,
separate origins with commas. Do not add paths after the host name.

## How files and room data are stored

Uploaded files are stored under `DATA_DIR/uploads`. The SQLite database
`DATA_DIR/video_index.sqlite3` contains their names, sizes, and fingerprints,
plus saved room codes, chat history, the selected room file, and the last
playback position. It does not contain the video bytes. The fingerprint is
calculated from file contents; changing only the name does not change it.

Connected members and pending file offers exist only in the running Python
process. After a server restart, the room, chat, selected file, and last
playback position are restored from SQLite, but people must reconnect and any
unfinished file offer is cleared. Playback resumes paused. An empty room is
expired after its configured timeout and is removed on the next room creation
or join; this delay allows a page refresh to reconnect. Uploaded files stay in
the data folder so they can be reused. Keep the data folder private because it
contains room chat and video metadata. The server does not delete saved media
automatically because files are kept for later reuse. It rejects a new unique
upload when `MAX_STORED_BYTES` would be exceeded; the owner must remove old
files and their matching rows from the video index to reclaim space.

The server issues a random private room token after a successful join. Browser
requests for upload, reuse, download, and LiveKit tokens must include that
token. The current tab’s session storage keeps the room details and shared
access code so it can rejoin after refresh, plus the private room token. These
values are readable by JavaScript running on this site, so this is a small
shared-code gate, not individual user accounts or identity verification. An
incorrect code is rejected, but attempts are not rate-limited.

The default file limit is 1 GiB. The browser currently downloads the complete
file before playing it, so large files can exceed phone memory or browser
storage limits. Hosting providers may impose a lower upload limit or request
timeout; choose a limit that fits your hosting plan.

## Deploy the backend to Render

Create a Python Web Service connected to this GitHub repository and deploy the
`main` branch.

- **Build command:** `pip install -r requirements.txt`
- **Start command:** `gunicorn --worker-class gthread --workers 1 --threads 100 --bind 0.0.0.0:$PORT app:app`
- **Environment:** set `SOPHISTICATED_CODE`, `A_CODE`, the three LiveKit settings, and
  `SOCKETIO_ALLOW_WEBSOCKET=1`. Set `FRONTEND_ORIGIN` to the exact Netlify site
  origin if Netlify hosts the page separately.

The threaded Gunicorn setup uses the installed `simple-websocket` package for
WebSocket support. Flask-SocketIO’s deployment documentation describes this
threaded option and notes that multiple processes require a message queue for
coordination: [Flask-SocketIO deployment](https://flask-socketio.readthedocs.io/en/latest/deployment.html).
This app also keeps room state in one process, so keep one Gunicorn worker and
one Render instance. Increasing worker or instance counts requires moving room
state to shared storage and configuring Socket.IO coordination first.

Render’s default filesystem is temporary. If you want uploads and the SQLite
index to survive a restart or deployment, attach a persistent disk and set
`DATA_DIR` to its mount path (for example `/var/data`). Render currently
requires a paid web service for a persistent disk; otherwise file changes can
be lost. See [Render persistent disks](https://render.com/docs/disks). Room
membership resets on restart even with a persistent disk. The saved playback
position is restored, but playback stays paused until someone presses play.

## Netlify frontend

Netlify publishes the `web` folder, as configured by `netlify.toml`. Set the
public backend address in `web/config.js` as `window.WATCH_API_URL`, then
redeploy the static site. The browser uses this address for both normal HTTP
requests and Socket.IO. A public frontend still needs a backend service running
somewhere; Netlify only serves the static frontend in this setup.

## LiveKit camera and microphone call

Flask creates LiveKit participant tokens valid for 10 minutes. The browser
connects to LiveKit Cloud for audio and video; the movie file is not sent to
LiveKit. Camera and microphone start off and are enabled by each participant
after granting browser permission. If LiveKit is unavailable, the watch room
and playback can still work.

Keep the LiveKit API secret only in `.env` locally or in the hosting provider’s
secret environment settings. If a key or secret is pasted into a public place
or shared unintentionally, revoke it in LiveKit and create a replacement.
