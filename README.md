<<<<<<< HEAD
# watch_together_service-
=======
# SideBySide

A first watch-together app using Flask (Python), Flask-SocketIO, and plain HTML/CSS/JavaScript.

The browser Socket.IO client is included locally at `web/vendor/socket.io.min.js` (socket.io-client 4.7.5), so loading the app does not depend on a third-party CDN.

## Run it locally

1. Install Python 3.10 or newer.
2. In this folder, create and activate a virtual environment:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```

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
>>>>>>> 63e9c5d (initial commit)
