// The API is same-origin when Flask serves this page. For Netlify, set the
// public Flask URL in config.js.
const API = (window.WATCH_API_URL || "").replace(/\/$/, "");
// Keep the page controls responsive if the Socket.IO client script fails to load.
// Room creation/joining will show a useful message rather than failing silently.
const socket =
  typeof window.io === "function"
    ? window.io(API || undefined, { autoConnect: false })
    : null;
const liveKit = window.LivekitClient || null;
const $ = (id) => document.getElementById(id);
const landing = $("landing"),
  roomView = $("room"),
  video = $("video");
let currentCode = "",
  nickname = "",
  roomToken = "",
  joinRequest = null,
  currentFile = null,
  incomingVideoOffer = null,
  pendingUploadOffer = null,
  latestPlayback = { paused: true, time: 0 },
  syncing = false,
  promptPending = false;
let liveKitRoom = null,
  liveKitJoinAttempt = 0,
  localCameraEnabled = false,
  localMicrophoneEnabled = false,
  mirroredCameraTrack = null,
  cameraSourceStream = null,
  cameraSourceVideo = null,
  cameraCanvas = null,
  cameraFrameRequest = null;
const liveKitTiles = new Map();
const ACTIVE_ROOM_KEY = "sidebyside.activeRoom";
const CLIENT_ID_KEY = "sidebyside.clientId";
const FINGERPRINT_CHUNK_SIZE = 8 * 1024 * 1024;
let toastTimeout = null;

function showToast(text) {
  const toast = $("toast");
  toast.textContent = text;
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 1800);
}

function cacheKeyForFile(file) {
  return file?.fingerprint || file?.id || "";
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function fingerprintFile(file, onProgress = () => {}) {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "This browser cannot check the file securely. Open the site using its HTTPS Cloudflare link.",
    );
  }

  const chunkHashes = [];
  for (let offset = 0; offset < file.size; offset += FINGERPRINT_CHUNK_SIZE) {
    const chunk = await file
      .slice(offset, offset + FINGERPRINT_CHUNK_SIZE)
      .arrayBuffer();
    chunkHashes.push(bytesToHex(await crypto.subtle.digest("SHA-256", chunk)));
    onProgress(Math.min(100, Math.round(((offset + chunk.byteLength) / file.size) * 100)));
  }

  const fingerprintInput = `${file.size}:${chunkHashes.join(":")}`;
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintInput)),
  );
}

function createOfferId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

async function askRoomBeforeUpload(file, fingerprint) {
  const offerId = createOfferId();
  let timeoutId;
  const result = await new Promise((resolve, reject) => {
    const finish = (value, error) => {
      if (!pendingUploadOffer || pendingUploadOffer.offerId !== offerId) return;
      pendingUploadOffer = null;
      clearTimeout(timeoutId);
      error ? reject(error) : resolve(value);
    };
    pendingUploadOffer = { offerId, finish };
    timeoutId = setTimeout(() => finish("timeout"), 30000);
    socket.emit(
      "offer_video",
      {
        code: currentCode,
        offer_id: offerId,
        fingerprint,
        name: file.name,
        size: file.size,
      },
      (response) => {
        if (!response?.ok) {
          finish(null, new Error(response?.error || "Could not ask the room."));
        } else if (response.expected_count === 0) {
          finish("no_peers");
        } else {
          message(
            $("roomMessage"),
            "Asking everyone whether they already have this video…",
          );
        }
      },
    );
  });
  return { offerId, result };
}

function replyToVideoOffer(hasFile) {
  if (!incomingVideoOffer || !socket) return;
  socket.emit("video_offer_response", {
    code: currentCode,
    offer_id: incomingVideoOffer.offer_id,
    has_file: hasFile,
  });
  incomingVideoOffer = null;
  $("downloadPrompt").classList.add("hidden");
  if (!hasFile) {
    message(
      $("roomMessage"),
      "You need a download. The person who added the video is preparing it.",
    );
  }
}

function getClientId() {
  try {
    let id = sessionStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id =
        globalThis.crypto?.randomUUID?.() ||
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

const clientId = getClientId();

function saveActiveRoom(code, name, accessCode, token = "") {
  try {
    sessionStorage.setItem(
      ACTIVE_ROOM_KEY,
      JSON.stringify({ code, name, accessCode, token }),
    );
  } catch {
    // The room still works if this browser does not allow session storage.
  }
}

function clearActiveRoom() {
  try {
    sessionStorage.removeItem(ACTIVE_ROOM_KEY);
  } catch {
    // Nothing else needs to change if session storage is unavailable.
  }
}

function openVideoCache() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("Browser storage unavailable"));
    const request = indexedDB.open("sidebyside-video-cache", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("videos")) {
        request.result.createObjectStore("videos");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getCachedVideo(fileId) {
  if (!fileId) return null;
  try {
    const database = await openVideoCache();
    return await new Promise((resolve) => {
      const transaction = database.transaction("videos", "readonly");
      const request = transaction.objectStore("videos").get(fileId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => {
        database.close();
        resolve(null);
      };
    });
  } catch {
    return null;
  }
}

async function cacheVideo(fileId, blob) {
  if (!fileId || !blob) return false;
  try {
    const database = await openVideoCache();
    return await new Promise((resolve) => {
      const transaction = database.transaction("videos", "readwrite");
      transaction.objectStore("videos").put(blob, fileId);
      transaction.oncomplete = () => {
        database.close();
        resolve(true);
      };
      transaction.onerror = transaction.onabort = () => {
        database.close();
        resolve(false);
      };
    });
  } catch {
    return false;
  }
}

function showCachedVideo(file, blob) {
  if (cacheKeyForFile(currentFile) !== cacheKeyForFile(file)) return false;
  loadVideoBlob(blob);
  $("fileStatus").textContent = "Saved in this browser";
  $("downloadFile").classList.add("hidden");
  message($("roomMessage"), "Using the video saved in this browser.");
  return true;
}

async function restoreCachedVideo(file) {
  const blob = await getCachedVideo(cacheKeyForFile(file));
  return blob ? showCachedVideo(file, blob) : false;
}

function message(target, text, isError = false) {
  target.textContent = text;
  target.classList.toggle("error", isError);
}
function showRoom(code) {
  currentCode = code;
  landing.classList.add("hidden");
  roomView.classList.remove("hidden");
  $("roomCode").textContent = code;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setCallStatus(text, isError = false) {
  const status = $("callStatus");
  status.textContent = text;
  status.classList.toggle("error", isError);
}

function mediaDeviceError(error, deviceName) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return `Allow browser access to the ${deviceName}, then try again.`;
    case "NotFoundError":
    case "DevicesNotFoundError":
      return `No ${deviceName} was found on this device.`;
    case "NotReadableError":
    case "TrackStartError":
      return `The ${deviceName} could not start. It may be in use by another app.`;
    case "OverconstrainedError":
      return `The ${deviceName} does not support the requested settings.`;
    default:
      return error?.message || `Could not start the ${deviceName}.`;
  }
}

function updateCallControls() {
  const connected = Boolean(liveKitRoom);
  const microphoneButton = $("toggleMicrophone");
  const cameraButton = $("toggleCamera");
  microphoneButton.disabled = !connected;
  cameraButton.disabled = !connected;
  microphoneButton.textContent = localMicrophoneEnabled
    ? "Turn microphone off"
    : "Turn microphone on";
  cameraButton.textContent = localCameraEnabled
    ? "Turn camera off"
    : "Turn camera on";
  microphoneButton.setAttribute("aria-pressed", String(localMicrophoneEnabled));
  cameraButton.setAttribute("aria-pressed", String(localCameraEnabled));
}

function ensureCallTile(participant, isLocal = false) {
  let entry = liveKitTiles.get(participant.identity);
  if (entry) {
    entry.name.textContent = isLocal
      ? `You (${nickname})`
      : participant.name || participant.identity;
    return entry;
  }

  const tile = document.createElement("article");
  tile.className = isLocal ? "call-tile call-tile-local" : "call-tile";
  const media = document.createElement("div");
  media.className = "call-tile-media";
  const videoElement = document.createElement("video");
  videoElement.autoplay = true;
  videoElement.playsInline = true;
  videoElement.muted = isLocal;
  videoElement.classList.add("hidden");
  const placeholder = document.createElement("span");
  placeholder.textContent = "Camera is off";
  videoElement.addEventListener("loadedmetadata", () => {
    if (videoElement.videoWidth && videoElement.videoHeight) {
      media.style.aspectRatio = `${videoElement.videoWidth} / ${videoElement.videoHeight}`;
    }
  });
  const name = document.createElement("div");
  name.className = "call-tile-name";
  name.textContent = isLocal
    ? `You (${nickname})`
    : participant.name || participant.identity;
  media.append(videoElement, placeholder);
  tile.append(media, name);
  $("callParticipants").append(tile);
  entry = { tile, media, video: videoElement, placeholder, name };
  liveKitTiles.set(participant.identity, entry);
  return entry;
}

function removeCallTile(identity) {
  const entry = liveKitTiles.get(identity);
  if (!entry) return;
  entry.video.srcObject = null;
  entry.tile.remove();
  liveKitTiles.delete(identity);
}

function showCallVideo(participant, track) {
  const entry = ensureCallTile(participant, participant.isLocal);
  track.attach(entry.video);
  if (entry.video.videoWidth && entry.video.videoHeight) {
    entry.media.style.aspectRatio = `${entry.video.videoWidth} / ${entry.video.videoHeight}`;
  }
  entry.video.classList.remove("hidden");
  entry.placeholder.classList.add("hidden");
}

function hideCallVideo(participant, track) {
  const entry = liveKitTiles.get(participant.identity);
  if (!entry) return;
  track.detach(entry.video);
  entry.video.srcObject = null;
  entry.media.style.aspectRatio = "";
  entry.video.classList.add("hidden");
  entry.placeholder.classList.remove("hidden");
}

async function startMirroredCamera() {
  cameraSourceStream = await navigator.mediaDevices.getUserMedia({ video: true });
  cameraSourceVideo = document.createElement("video");
  cameraSourceVideo.muted = true;
  cameraSourceVideo.playsInline = true;
  cameraSourceVideo.srcObject = cameraSourceStream;
  await cameraSourceVideo.play();

  cameraCanvas = document.createElement("canvas");
  const context = cameraCanvas.getContext("2d");
  if (!context || !cameraCanvas.captureStream) {
    throw new Error("This browser cannot create a mirrored camera stream.");
  }
  const drawMirroredFrame = () => {
    if (!cameraSourceVideo || !cameraCanvas) return;
    const width = cameraSourceVideo.videoWidth;
    const height = cameraSourceVideo.videoHeight;
    if (width && height) {
      if (cameraCanvas.width !== width || cameraCanvas.height !== height) {
        cameraCanvas.width = width;
        cameraCanvas.height = height;
      }
      context.save();
      context.translate(width, 0);
      context.scale(-1, 1);
      context.drawImage(cameraSourceVideo, 0, 0, width, height);
      context.restore();
    }
    cameraFrameRequest = requestAnimationFrame(drawMirroredFrame);
  };
  drawMirroredFrame();

  const outgoingTrack = cameraCanvas.captureStream(24).getVideoTracks()[0];
  if (!outgoingTrack) throw new Error("Could not create the mirrored camera track.");
  mirroredCameraTrack = new liveKit.LocalVideoTrack(outgoingTrack);
  await liveKitRoom.localParticipant.publishTrack(mirroredCameraTrack, {
    source: liveKit.Track.Source.Camera,
  });
}

async function stopMirroredCamera() {
  if (cameraFrameRequest !== null) cancelAnimationFrame(cameraFrameRequest);
  cameraFrameRequest = null;
  if (mirroredCameraTrack && liveKitRoom) {
    try {
      await liveKitRoom.localParticipant.unpublishTrack(mirroredCameraTrack, true);
    } catch (error) {
      console.warn("Could not unpublish the mirrored camera track:", error);
    }
  }
  mirroredCameraTrack = null;
  cameraSourceStream?.getTracks().forEach((track) => track.stop());
  cameraSourceStream = null;
  if (cameraSourceVideo) cameraSourceVideo.srcObject = null;
  cameraSourceVideo = null;
  cameraCanvas = null;
}

async function joinLiveKitCall(code) {
  const attempt = ++liveKitJoinAttempt;
  if (!liveKit?.Room || !liveKit?.RoomEvent) {
    setCallStatus(
      "The call library did not load. You can still watch together; reload the page to try again.",
      true,
    );
    return;
  }

  if (liveKitRoom) liveKitRoom.disconnect();
  liveKitRoom = null;
  localCameraEnabled = false;
  localMicrophoneEnabled = false;
  $("callParticipants").replaceChildren();
  $("enableCallAudio").classList.add("hidden");
  updateCallControls();
  setCallStatus("Connecting to the room call…");

  let connectingRoom = null;
  try {
    const tokenResponse = await fetch(`${API}/api/rooms/${code}/livekit-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Room-Token": roomToken,
      },
      body: "{}",
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(tokenData.error || "Could not prepare the room call.");
    }
    if (attempt !== liveKitJoinAttempt) return;

    const room = new liveKit.Room({ adaptiveStream: true, dynacast: true });
    connectingRoom = room;
    room.on(liveKit.RoomEvent.ParticipantConnected, (participant) => {
      ensureCallTile(participant);
    });
    room.on(liveKit.RoomEvent.ParticipantDisconnected, (participant) => {
      removeCallTile(participant.identity);
    });
    room.on(
      liveKit.RoomEvent.TrackSubscribed,
      (track, _publication, participant) => {
        if (track.kind === liveKit.Track.Kind.Video) {
          showCallVideo(participant, track);
        } else if (track.kind === liveKit.Track.Kind.Audio) {
          const audioElement = track.attach();
          audioElement.autoplay = true;
          $("callAudio").append(audioElement);
        }
      },
    );
    room.on(
      liveKit.RoomEvent.TrackUnsubscribed,
      (track, _publication, participant) => {
        if (track.kind === liveKit.Track.Kind.Video) {
          hideCallVideo(participant, track);
        } else {
          const detached = track.detach();
          for (const element of Array.isArray(detached) ? detached : [detached]) {
            element?.remove();
          }
        }
      },
    );
    room.on(liveKit.RoomEvent.TrackMuted, (publication, participant) => {
      if (
        publication.source === liveKit.Track.Source.Camera &&
        publication.track
      ) {
        hideCallVideo(participant, publication.track);
      }
    });
    room.on(liveKit.RoomEvent.TrackUnmuted, (publication, participant) => {
      if (
        publication.source === liveKit.Track.Source.Camera &&
        publication.track
      ) {
        showCallVideo(participant, publication.track);
      }
    });
    room.on(liveKit.RoomEvent.MediaDevicesError, (error) => {
      setCallStatus(
        `Call device problem: ${error?.message || "check camera and microphone permissions."}`,
        true,
      );
    });
    room.on(liveKit.RoomEvent.AudioPlaybackStatusChanged, () => {
      $("enableCallAudio").classList.toggle("hidden", room.canPlaybackAudio);
    });
    room.on(liveKit.RoomEvent.Disconnected, () => {
      if (liveKitRoom !== room) return;
      liveKitRoom = null;
      void stopMirroredCamera();
      localCameraEnabled = false;
      localMicrophoneEnabled = false;
      updateCallControls();
      setCallStatus("The call disconnected. You can remain in the watch room.", true);
    });

    await room.connect(tokenData.server_url, tokenData.participant_token);
    if (attempt !== liveKitJoinAttempt) {
      room.disconnect();
      return;
    }
    liveKitRoom = room;
    ensureCallTile(room.localParticipant, true);
    for (const participant of room.remoteParticipants.values()) {
      ensureCallTile(participant);
    }
    updateCallControls();
    setCallStatus("Call connected. Camera and microphone are off until you turn them on.");
  } catch (error) {
    if (attempt !== liveKitJoinAttempt) return;
    connectingRoom?.disconnect();
    liveKitRoom = null;
    localCameraEnabled = false;
    localMicrophoneEnabled = false;
    updateCallControls();
    setCallStatus(
      `${error.message || "The call could not connect."} You can still watch together.`,
      true,
    );
  }
}

function leaveLiveKitCall() {
  liveKitJoinAttempt += 1;
  const room = liveKitRoom;
  liveKitRoom = null;
  localCameraEnabled = false;
  localMicrophoneEnabled = false;
  if (room) room.disconnect();
  if (cameraFrameRequest !== null) cancelAnimationFrame(cameraFrameRequest);
  cameraFrameRequest = null;
  cameraSourceStream?.getTracks().forEach((track) => track.stop());
  cameraSourceStream = null;
  cameraSourceVideo = null;
  cameraCanvas = null;
  mirroredCameraTrack = null;
  for (const identity of liveKitTiles.keys()) removeCallTile(identity);
  $("callAudio").replaceChildren();
  $("enableCallAudio").classList.add("hidden");
  updateCallControls();
}

$("toggleMicrophone").addEventListener("click", async () => {
  if (!liveKitRoom) return;
  const nextState = !localMicrophoneEnabled;
  try {
    await liveKitRoom.localParticipant.setMicrophoneEnabled(nextState);
    localMicrophoneEnabled = nextState;
    updateCallControls();
    setCallStatus(
      `Call connected. Microphone ${nextState ? "on" : "off"}; camera ${localCameraEnabled ? "on" : "off"}.`,
    );
  } catch (error) {
    setCallStatus(
      `${mediaDeviceError(error, "microphone")} You can still watch together.`,
      true,
    );
  }
});

$("toggleCamera").addEventListener("click", async () => {
  if (!liveKitRoom) return;
  const nextState = !localCameraEnabled;
  try {
    if (nextState) {
      await startMirroredCamera();
    } else {
      await stopMirroredCamera();
    }
    localCameraEnabled = nextState;
    updateCallControls();
    if (nextState) {
      const publication = liveKitRoom.localParticipant.getTrackPublication(
        liveKit.Track.Source.Camera,
      );
      if (publication?.track) showCallVideo(liveKitRoom.localParticipant, publication.track);
    } else {
      const entry = liveKitTiles.get(liveKitRoom.localParticipant.identity);
      if (entry) {
        entry.video.srcObject = null;
        entry.media.style.aspectRatio = "";
        entry.video.classList.add("hidden");
        entry.placeholder.classList.remove("hidden");
      }
    }
    setCallStatus(
      `Call connected. Microphone ${localMicrophoneEnabled ? "on" : "off"}; camera ${nextState ? "on" : "off"}.`,
    );
  } catch (error) {
    await stopMirroredCamera();
    setCallStatus(
      `${mediaDeviceError(error, "camera")} You can still watch together.`,
      true,
    );
  }
});

$("enableCallAudio").addEventListener("click", async () => {
  if (!liveKitRoom) return;
  try {
    await liveKitRoom.startAudio();
    $("enableCallAudio").classList.add("hidden");
  } catch {
    setCallStatus("Tap the audio button again to allow call audio in this browser.", true);
  }
});

function connectAndJoin(code, name, accessCode = $("accessCode").value.trim()) {
  if (!accessCode) {
    message($("landingMessage"), "Enter the shared access code.", true);
    return;
  }
  nickname = name;
  joinRequest = { code, name, accessCode };
  if (!socket) {
    message(
      $("landingMessage"),
      "The live-connection library did not load. Check your internet connection and reload the page.",
      true,
    );
    return;
  }
  saveActiveRoom(code, name, accessCode);
  message($("landingMessage"), "Connecting to the room…");
  const emitJoinRequest = () =>
    socket.emit("join_room", {
      code,
      nickname,
      client_id: clientId,
      access_code: accessCode,
    });
  joinRequest.emit = emitJoinRequest;
  if (socket.connected) emitJoinRequest();
  else socket.connect();
}

socket?.on("connect", () => {
  if (joinRequest?.emit) {
    message(
      currentCode ? $("roomMessage") : $("landingMessage"),
      currentCode ? "Reconnected. Restoring your room…" : "Connecting to the room…",
    );
    joinRequest.emit();
  }
});
socket?.on("disconnect", () => {
  if (currentCode) {
    roomToken = "";
    message($("roomMessage"), "Connection lost. Reconnecting to your room…", true);
  }
});

$("createRoom").addEventListener("click", () => {
  $("joinForm").classList.add("hidden");
  $("createForm").classList.toggle("hidden");
  if (!$("createForm").classList.contains("hidden")) {
    $("createNickname").focus();
    $("createForm").scrollIntoView({ behavior: "smooth", block: "center" });
  }
});
$("createForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("createNickname").value.trim();
  const accessCode = $("accessCode").value.trim();
  if (!name) {
    return message(
      $("landingMessage"),
      "Enter a nickname to create your room.",
      true,
    );
  }
  if (!accessCode) {
    return message($("landingMessage"), "Enter the shared access code.", true);
  }
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const response = await fetch(`${API}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: accessCode }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Could not create a room.");
    connectAndJoin(result.code, name.slice(0, 24), accessCode);
  } catch (error) {
    message($("landingMessage"), error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("showJoin").addEventListener("click", () => {
  $("createForm").classList.add("hidden");
  $("joinForm").classList.toggle("hidden");
  if (!$("joinForm").classList.contains("hidden")) {
    $("joinCode").focus();
    $("joinForm").scrollIntoView({ behavior: "smooth", block: "center" });
  }
});
$("joinCode").addEventListener("input", (event) => {
  event.target.value = event.target.value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
});
$("joinForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const code = $("joinCode").value.trim(),
    name = $("joinNickname").value.trim(),
    accessCode = $("accessCode").value.trim();
  if (code.length !== 6)
    return message(
      $("landingMessage"),
      "Enter the six-character room code.",
      true,
    );
  if (!name)
    return message($("landingMessage"), "Enter a nickname to join.", true);
  if (!accessCode)
    return message($("landingMessage"), "Enter the shared access code.", true);
  connectAndJoin(code, name.slice(0, 24), accessCode);
});

function renderChatMessage(data) {
  const item = document.createElement("article");
  item.className = "chat-message";
  const heading = document.createElement("div");
  heading.className = "chat-message-heading";
  const sender = document.createElement("span");
  sender.className = "chat-message-name";
  sender.textContent = data.nickname || "Room member";
  const time = document.createElement("time");
  time.className = "chat-message-time";
  const sentAt = new Date(data.sent_at);
  time.textContent = Number.isNaN(sentAt.getTime())
    ? ""
    : sentAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const text = document.createElement("p");
  text.className = "chat-message-text";
  text.textContent = data.text || "";
  heading.append(sender, time);
  item.append(heading, text);
  $("chatMessages").append(item);
}

socket?.on("joined", (data) => {
  roomToken = data.member_token || "";
  if (!roomToken) {
    message($("landingMessage"), "The server did not authorize this room session.", true);
    return;
  }
  saveActiveRoom(
    data.code,
    nickname,
    joinRequest?.accessCode || "",
    roomToken,
  );
  $("accessCode").value = "";
  showRoom(data.code);
  $("chatMessages").replaceChildren();
  $("chatStatus").textContent = "";
  (data.chat_messages || []).forEach(renderChatMessage);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  renderMembers(data.members);
  latestPlayback = data.playback || { paused: true, time: 0 };
  if (data.file) {
    setFile(data.file, false);
    restoreCachedVideo(data.file).then((isCached) => {
      if (!isCached && data.file.available === false) {
        message(
          $("roomMessage"),
          "This room has no server copy yet. Choose your matching local file, or ask the uploader to upload one.",
        );
      }
    });
  }
  if (currentFile) applyPlayback(latestPlayback);
  message($("roomMessage"), "You’re in. Share the code so others can join.");
  joinLiveKitCall(data.code);
});
socket?.on("join_error", (data) => {
  roomToken = "";
  joinRequest = null;
  clearActiveRoom();
  if (currentCode) {
    leaveLiveKitCall();
    video.pause();
    if (video.src.startsWith("blob:")) URL.revokeObjectURL(video.src);
    video.removeAttribute("src");
    video.load();
    $("emptyVideo").classList.remove("hidden");
    $("fileReady").classList.add("hidden");
    $("noFile").classList.remove("hidden");
    currentCode = "";
    currentFile = null;
    roomView.classList.add("hidden");
    landing.classList.remove("hidden");
  }
  message($("landingMessage"), data.message, true);
});
socket?.on("connect_error", () =>
  message(
    currentCode ? $("roomMessage") : $("landingMessage"),
    "Could not reach the room server. Checking the connection…",
    true,
  ),
);
socket?.on("members", (data) => renderMembers(data.members));
socket?.on("chat_message", (data) => {
  renderChatMessage(data);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
});
$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  if (!socket?.connected || !currentCode) {
    $("chatStatus").textContent = "Reconnect to the room before sending a message.";
    return;
  }
  socket.emit("chat_send", { code: currentCode, text }, (response) => {
    if (!response?.ok) {
      $("chatStatus").textContent = response?.error || "The message could not be sent.";
      return;
    }
    input.value = "";
    $("chatStatus").textContent = "";
    input.focus();
  });
});
socket?.on("file_available", (data) => {
  if (incomingVideoOffer?.fingerprint === data.fingerprint) {
    incomingVideoOffer = null;
    $("downloadPrompt").classList.add("hidden");
  }
  const uploadedByMe = socket && data.uploader_id === socket.id;
  setFile(data, !uploadedByMe, uploadedByMe);
  if (uploadedByMe) {
    message(
      $("roomMessage"),
      "Video uploaded. Everyone else in the room has been invited to download it.",
    );
    return;
  }
  restoreCachedVideo(data).then((isCached) => {
    if (isCached) return;
    $("promptTitle").textContent = "Join the movie night?";
    $("promptUseExisting").textContent = "Use a file on this device";
    $("promptDownload").textContent = "Download video";
    $("dismissPrompt").textContent = "Later";
    $("promptText").textContent =
      `${data.name} is ready. Download it to watch along.`;
    $("downloadPrompt").classList.remove("hidden");
  });
});
socket?.on("video_offer", (offer) => {
  incomingVideoOffer = offer;
  $("promptTitle").textContent = "Already have this video?";
  $("promptText").textContent =
    `${offer.name} is being added to the room. Choose your copy to check it, or say you need a download.`;
  $("promptUseExisting").textContent = "I have it — choose my file";
  $("promptDownload").textContent = "I need a download";
  $("dismissPrompt").textContent = "I’ll download later";
  $("downloadPrompt").classList.remove("hidden");
});
socket?.on("video_offer_progress", (progress) => {
  if (pendingUploadOffer?.offerId !== progress.offer_id) return;
  if (progress.need_count > 0) {
    pendingUploadOffer.finish("someone_needs_it");
  } else if (progress.all_responded) {
    pendingUploadOffer.finish("everyone_has_it");
  } else {
    message(
      $("roomMessage"),
      `${progress.have_count} person(s) have a matching copy. Waiting for the others…`,
    );
  }
});
socket?.on("playback", (state) => {
  latestPlayback = state;
  applyPlayback(state);
});
setInterval(() => {
  if (socket?.connected && currentCode && currentFile && video.src) {
    socket.emit("playback_sync", {
      code: currentCode,
      file_id: currentFile.id,
    });
  }
}, 5000);

// A reload creates a new Socket.IO connection. Rejoin the room remembered for
// this tab instead of showing the landing page again.
try {
  const savedRoom = JSON.parse(sessionStorage.getItem(ACTIVE_ROOM_KEY) || "null");
  if (savedRoom?.code && savedRoom?.name && savedRoom?.accessCode) {
    connectAndJoin(savedRoom.code, savedRoom.name, savedRoom.accessCode);
  } else if (savedRoom?.code && savedRoom?.name) {
    clearActiveRoom();
    message(
      $("landingMessage"),
      "Enter the shared access code to rejoin your previous room.",
    );
  }
} catch {
  clearActiveRoom();
}

function renderMembers(members) {
  $("memberCount").textContent = members.length;
  $("memberList").replaceChildren(
    ...members.map((member) => {
      const li = document.createElement("li"),
        avatar = document.createElement("span"),
        label = document.createElement("span");
      avatar.className = "member-avatar";
      avatar.textContent = member.nickname.slice(0, 1).toUpperCase();
      label.textContent = member.nickname;
      li.append(avatar, label);
      if (member.id === socket.id) {
        const you = document.createElement("span");
        you.className = "you-tag";
        you.textContent = "you";
        li.append(you);
      }
      return li;
    }),
  );
}
function setFile(file, announce, uploadedByMe = false) {
  if (currentFile && currentFile.id !== file.id) {
    video.pause();
    if (video.src.startsWith("blob:")) URL.revokeObjectURL(video.src);
    video.removeAttribute("src");
    video.load();
    $("emptyVideo").classList.remove("hidden");
    latestPlayback = {
      paused: true,
      time: 0,
      file_id: file.id,
    };
  }
  currentFile = file;
  $("noFile").classList.add("hidden");
  $("fileReady").classList.remove("hidden");
  $("fileChooserText").textContent = "Choose another audio or video";
  $("fileName").textContent = file.name;
  $("fileStatus").textContent = uploadedByMe
    ? "Using your selected file"
    : file.available === false
      ? "Only available from a matching local file"
      : announce
        ? "Ready for everyone to download"
        : "Available in this room";
  $("downloadFile").classList.toggle(
    "hidden",
    uploadedByMe || file.available === false,
  );
  $("existingFileButton").classList.toggle("hidden", uploadedByMe);
  $("emptyVideo").classList.toggle("hidden", Boolean(video.src));
}

function loadLocalFile(file) {
  loadVideoBlob(file);
}

function loadVideoBlob(blob) {
  if (video.src.startsWith("blob:")) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(blob);
  video.load();
  $("emptyVideo").classList.add("hidden");
}

$("fileInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file || !currentCode) return;
  const progress = $("uploadProgress"),
    bar = $("progressBar");
  progress.classList.remove("hidden");
  bar.style.width = "0%";
  try {
    message($("roomMessage"), "Checking the video file… 0%");
    let nextProgressMessage = 5;
    const fingerprint = await fingerprintFile(file, (percent) => {
      bar.style.width = `${percent}%`;
      if (percent >= nextProgressMessage) {
        message($("roomMessage"), `Checking the video file… ${percent}%`);
        nextProgressMessage = percent + 5;
      }
    });

    message($("roomMessage"), "Checking whether Flask already has this video…");
    const reuseResponse = await fetch(
      `${API}/api/rooms/${currentCode}/reuse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Room-Token": roomToken,
        },
        body: JSON.stringify({
          fingerprint,
          name: file.name,
        }),
      },
    );
    const reuseResult = await reuseResponse.json();
    if (!reuseResponse.ok) {
      throw new Error(reuseResult.error || "Could not check the server’s videos.");
    }

    if (reuseResult.found) {
      await cacheVideo(cacheKeyForFile(reuseResult), file);
      setFile(reuseResult, false, true);
      loadLocalFile(file);
      message(
        $("roomMessage"),
        "This video was already on the server, so it was added to the room without uploading it again.",
      );
      return;
    }

    let offerId = "";
    if (socket?.connected) {
      const offer = await askRoomBeforeUpload(file, fingerprint);
      offerId = offer.offerId;
      if (offer.result === "everyone_has_it") {
        const roomFile = {
          id: offerId,
          fingerprint,
          name: file.name,
          size: file.size,
          available: false,
        };
        await cacheVideo(cacheKeyForFile(roomFile), file);
        setFile(roomFile, false, true);
        loadLocalFile(file);
        message(
          $("roomMessage"),
          "Everyone has the matching video. It’s ready to watch; Flask did not need a video upload.",
        );
        return;
      }
    }

    bar.style.width = "8%";
    message(
      $("roomMessage"),
      "This is new to the server. Uploading the video now…",
    );
    const form = new FormData();
    form.append("file", file);
    form.append("offer_id", offerId);
    const xhr = new XMLHttpRequest();
    const uploaded = await new Promise((resolve, reject) => {
      xhr.open("POST", `${API}/api/rooms/${currentCode}/upload`);
      xhr.setRequestHeader("X-Room-Token", roomToken);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
      };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        xhr.status < 300
          ? resolve(data)
          : reject(new Error(data.error || "Upload failed."));
      };
      xhr.onerror = () =>
        reject(new Error("Upload failed. Check the connection and try again."));
      xhr.send(form);
    });
    await cacheVideo(cacheKeyForFile(uploaded), file);
    setFile(uploaded, false, true);
    loadLocalFile(file);
    message(
      $("roomMessage"),
      "Video uploaded. Everyone else in the room has been invited to download it.",
    );
  } catch (error) {
    message($("roomMessage"), error.message, true);
  } finally {
    setTimeout(() => progress.classList.add("hidden"), 700);
    event.target.value = "";
  }
});
async function downloadAndPlay() {
  if (!currentCode || !currentFile) return;
  $("downloadPrompt").classList.add("hidden");
  message($("roomMessage"), "Downloading the video…");
  try {
    let blob = await getCachedVideo(cacheKeyForFile(currentFile));
    const alreadyCached = Boolean(blob);
    let savedInBrowser = alreadyCached;
    if (!blob) {
      const response = await fetch(`${API}/api/rooms/${currentCode}/download`, {
        headers: { "X-Room-Token": roomToken },
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Download failed.");
      }
      blob = await response.blob();
      savedInBrowser = await cacheVideo(cacheKeyForFile(currentFile), blob);
    }
    loadVideoBlob(blob);
    if (!alreadyCached) {
      const saveLink = document.createElement("a");
      saveLink.href = video.src;
      saveLink.download = currentFile.name;
      saveLink.click();
    }
    $("fileStatus").textContent = savedInBrowser
      ? "Saved in this browser"
      : "Downloaded on this device; browser storage is full";
    $("downloadFile").classList.toggle("hidden", savedInBrowser);
    message(
      $("roomMessage"),
      alreadyCached
        ? "Using the video saved in this browser."
        : savedInBrowser
          ? "Downloaded and saved in this browser. Press play when you’re ready to watch together."
          : "Downloaded, but this browser could not keep a reusable copy. Press play when you’re ready to watch together.",
    );
  } catch (error) {
    message($("roomMessage"), error.message, true);
  }
}

$("existingFileInput").addEventListener("change", async (event) => {
  const selectedFile = event.target.files[0];
  const roomFile = incomingVideoOffer || currentFile;
  if (!selectedFile || !roomFile) return;

  if (!roomFile.fingerprint) {
    message(
      $("roomMessage"),
      "This room’s video was uploaded before file matching was available. Upload it again to enable matching.",
      true,
    );
    event.target.value = "";
    return;
  }

  let nextProgressMessage = 5;
  message($("roomMessage"), "Checking the selected file… 0%");
  try {
    const fingerprint = await fingerprintFile(selectedFile, (percent) => {
      if (percent >= nextProgressMessage) {
        message($("roomMessage"), `Checking the selected file… ${percent}%`);
        nextProgressMessage = percent + 5;
      }
    });

    if (incomingVideoOffer && incomingVideoOffer.offer_id === roomFile.offer_id) {
      if (fingerprint !== roomFile.fingerprint) {
        throw new Error(
          "That file does not match the video being offered. Choose the exact same file, or say you need a download.",
        );
      }

      replyToVideoOffer(true);
      const matchedFile = {
        id: roomFile.offer_id,
        fingerprint: roomFile.fingerprint,
        name: roomFile.name,
        size: roomFile.size,
        available: false,
      };
      await cacheVideo(cacheKeyForFile(matchedFile), selectedFile);
      setFile(matchedFile, false, false);
      loadLocalFile(selectedFile);
      message(
        $("roomMessage"),
        "Your file matches. Using it locally; it did not need to be uploaded or downloaded.",
      );
      return;
    }

    if (currentFile !== roomFile) return;
    if (fingerprint !== roomFile.fingerprint) {
      throw new Error(
        roomFile.available === false
          ? "That file does not match. Choose the exact same file, or ask the person who added the video to upload a copy."
          : "That file does not exactly match the video shared in this room. Choose the original file or download the shared video.",
      );
    }

    await cacheVideo(cacheKeyForFile(roomFile), selectedFile);
    loadLocalFile(selectedFile);
    $("fileStatus").textContent = "Using your matching file on this device";
    $("downloadFile").classList.add("hidden");
    $("downloadPrompt").classList.add("hidden");
    message(
      $("roomMessage"),
      "This is the same video. Using your copy, so no download was needed.",
    );
  } catch (error) {
    message($("roomMessage"), error.message, true);
  } finally {
    event.target.value = "";
  }
});

$("downloadFile").addEventListener("click", downloadAndPlay);
$("promptDownload").addEventListener("click", () => {
  if (incomingVideoOffer) replyToVideoOffer(false);
  else downloadAndPlay();
});
$("promptUseExisting").addEventListener("click", () => {
  $("existingFileInput").click();
});
$("dismissPrompt").addEventListener("click", () =>
  incomingVideoOffer ? replyToVideoOffer(false) : $("downloadPrompt").classList.add("hidden"),
);
$("copyCode").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentCode);
    showToast("Copied!");
  } catch {
    message($("roomMessage"), `Share this code: ${currentCode}`);
  }
});

function sendPlayback() {
  if (syncing || !socket || !currentCode || !video.src) return;
  socket.emit("playback", {
    code: currentCode,
    file_id: currentFile?.id || null,
    paused: video.paused,
    time: video.currentTime,
  });
}
video.addEventListener("pause", sendPlayback);
video.addEventListener("play", sendPlayback);
video.addEventListener("seeked", sendPlayback);
video.addEventListener("loadedmetadata", () => {
  if (currentCode) applyPlayback(latestPlayback);
});
function applyPlayback(state) {
  if (
    !video.src ||
    (state.file_id && state.file_id !== currentFile?.id) ||
    video.readyState < HTMLMediaElement.HAVE_METADATA ||
    !Number.isFinite(Number(state.time))
  )
    return;
  syncing = true;
  const target = Number(state.time);
  if (Math.abs(video.currentTime - target) > 0.8) video.currentTime = target;
  if (state.paused && !video.paused) video.pause();
  else if (!state.paused && video.paused)
    video
      .play()
      .catch(() =>
        message(
          $("roomMessage"),
          "Press play once to allow synchronized playback.",
        ),
      );
  setTimeout(() => {
    syncing = false;
  }, 120);
}

window.addEventListener("pagehide", () => {
  leaveLiveKitCall();
  if (!currentCode) return;

  const body = new FormData();
  body.append("room_token", roomToken);
  const leaveUrl = `${API}/api/rooms/${currentCode}/leave`;

  // sendBeacon can finish this small request while the page is closing.
  // The Socket.IO disconnect handler remains the fallback if it cannot send.
  if (!navigator.sendBeacon?.(leaveUrl, body)) {
    fetch(leaveUrl, { method: "POST", body, keepalive: true }).catch(() => {});
  }
  roomToken = "";
});

$("leaveRoom").addEventListener("click", () => {
  clearActiveRoom();
  roomToken = "";
  joinRequest = null;
  leaveLiveKitCall();
  if (currentCode && socket) socket.emit("leave_room", { code: currentCode });
  socket?.disconnect();
  if (video.src.startsWith("blob:")) URL.revokeObjectURL(video.src);
  video.pause();
  video.removeAttribute("src");
  video.load();
  currentCode = "";
  currentFile = null;
  incomingVideoOffer = null;
  pendingUploadOffer = null;
  latestPlayback = { paused: true, time: 0 };
  nickname = "";
  $("roomCode").textContent = "------";
  $("memberCount").textContent = "0";
  $("memberList").replaceChildren();
  $("noFile").classList.remove("hidden");
  $("fileReady").classList.add("hidden");
  $("existingFileButton").classList.add("hidden");
  $("fileChooserText").textContent = "Choose audio or video";
  $("fileName").textContent = "Video file";
  $("fileStatus").textContent = "Ready to download";
  $("downloadFile").classList.remove("hidden");
  $("fileInput").value = "";
  $("existingFileInput").value = "";
  $("downloadPrompt").classList.add("hidden");
  $("uploadProgress").classList.add("hidden");
  $("progressBar").style.width = "0";
  $("createForm").classList.add("hidden");
  $("joinForm").classList.add("hidden");
  $("createNickname").value = "";
  $("joinCode").value = "";
  $("joinNickname").value = "";
  roomView.classList.add("hidden");
  landing.classList.remove("hidden");
  message($("roomMessage"), "");
  message($("landingMessage"), "You left the room.");
});
