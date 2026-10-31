# SideBySide

A first watch-together app using Flask (Python), Flask-SocketIO, and plain HTML/CSS/JavaScript.

The browser Socket.IO client is included locally at `web/vendor/socket.io.min.js` (socket.io-client 4.7.5), so loading the app does not depend on a third-party CDN.
The LiveKit browser client is included locally at `web/vendor/livekit-client.umd.js` (livekit-client 2.23.0); its license is next to the file.

## Run it locally

1. Install Python 3.10 or newer.
2. In this folder, create and activate a virtual environment:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   Copy-Item .env.example .env
   ```

   Edit `.env` and add your private LiveKit credentials before starting the server.

3. Start the server:

   ```powershell
   py app.py
   ```

4. Open http://127.0.0.1:5000. Open another browser window to try joining the same room.

The local Werkzeug development server uses Socket.IO polling by default. This
avoids noisy WebSocket shutdown tracebacks when a browser leaves a room. When
you later run Flask behind a server that supports WebSockets, set
`SOCKETIO_ALLOW_WEBSOCKET=1` before starting Flask to enable WebSocket upgrades.

## What works in this first version

- Create a six-character room code; join with that code and a nickname.
- See who is in the room.
- Remove a member from the room when they leave or close the page.
- Upload a local audio/video file to the Flask computer; room members get a download prompt.
- Download the file into the browser and play it. Play/pause and seek updates are shared; volume remains local.

Rooms and uploaded files are held on the Flask computer. Room data is in memory and is cleared if Flask restarts. Uploaded files live in `uploads/` until replaced or manually removed.

## Netlify and a Flask computer

Netlify publishes the `web` folder. Flask must still run on a computer reachable from the internet. For a temporary trial, start Flask and use a tunnel such as Cloudflare Tunnel to get a public address. Put that address in `web/config.js` as `window.WATCH_API_URL`, then redeploy the site. The browser uses that address for both regular requests and Socket.IO. Keep Flask and the tunnel running for the room to work. The backend allows cross-origin requests by default in this learning version; before making a public service, restrict `FRONTEND_ORIGIN` to your Netlify site URL.

This is a learning prototype, not a hardened public service: room codes are the only join check, there is no creator authentication, and the server has no persistent database or automatic upload cleanup. Large uploads use your computer's storage and internet connection. Some browser video formats/codecs may not play on every device.

## Optional camera and microphone call

The call uses LiveKit Cloud for WebRTC audio/video. Flask continues to manage
watch-room membership and synchronized movie playback. The call connects
separately to LiveKit; the movie file is not sent to LiveKit.

### Create the LiveKit project

1. Create an account at [LiveKit Cloud](https://cloud.livekit.io/) and create a
   project. The free Build plan is enough to try the feature.
2. Open the project settings and copy its WebSocket URL, API key, and API
   secret. The URL starts with `wss://`.
3. Copy `.env.example` to `.env` and enter these values in `.env`. Never put
   the API secret in browser JavaScript or commit it to GitHub:

   ```text
   LIVEKIT_URL=wss://your-project.livekit.cloud
   LIVEKIT_API_KEY=your-project-api-key
   LIVEKIT_API_SECRET=your-project-api-secret
   ```

Flask loads `.env` automatically when it starts. The `.env` file is ignored by
Git, so its secrets stay on your computer. For Render, add the same names in
the service's Environment settings and enter the values from LiveKit Cloud.

### Install and run

After pulling the code, install the added Python dependency with
`pip install -r requirements.txt`. The LiveKit browser library is stored in
`web/vendor`, so the web page does not need a third-party CDN to load it.

When a participant joins a watch room, Flask checks that participant's active
Socket.IO membership and creates a short-lived LiveKit token for that room.
The browser connects to LiveKit with the token. Camera and microphone start
off; each participant turns them on separately and grants browser permission.
If LiveKit is not configured or a device cannot be used, participants can
still stay in the watch room and use synchronized playback.

If Netlify hosts the page separately, keep `WATCH_API_URL` pointed at the
public Flask server and set `FRONTEND_ORIGIN` on Flask to the Netlify site
origin. LiveKit's URL and API key are configured on Flask; the API secret
must remain server-side.

LiveKit Cloud's free-plan limits can change. Check the project's LiveKit
dashboard before sharing the service widely.
