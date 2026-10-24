// The API is same-origin when Flask serves this page. For Netlify, set the
// public Flask URL in config.js.
const API = (window.WATCH_API_URL || "").replace(/\/$/, "");
// Keep the page controls responsive if the Socket.IO client script fails to load.
// Room creation/joining will show a useful message rather than failing silently.
const socket =
  typeof window.io === "function"
    ? window.io(API || undefined, { autoConnect: false })
    : null;
const $ = (id) => document.getElementById(id);
const landing = $("landing"),
  roomView = $("room"),
  video = $("video");
let currentCode = "",
  nickname = "",
  currentFile = null,
  incomingVideoOffer = null,
  pendingUploadOffer = null,
  latestPlayback = { paused: true, time: 0 },
  syncing = false,
  promptPending = false;
const ACTIVE_ROOM_KEY = "sidebyside.activeRoom";
const CLIENT_ID_KEY = "sidebyside.clientId";
const FINGERPRINT_CHUNK_SIZE = 8 * 1024 * 1024;

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

function saveActiveRoom(code, name) {
  try {
    sessionStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify({ code, name }));
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
function connectAndJoin(code, name) {
  nickname = name;
  if (!socket) {
    message(
      $("landingMessage"),
      "The live-connection library did not load. Check your internet connection and reload the page.",
      true,
    );
    return;
  }
  saveActiveRoom(code, name);
  message($("landingMessage"), "Connecting to the room…");
  if (!socket.connected) socket.connect();
  const joinWhenReady = () =>
    socket.emit("join_room", { code, nickname, client_id: clientId });
  if (socket.connected) joinWhenReady();
  else socket.once("connect", joinWhenReady);
}

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
  if (!name) {
    return message(
      $("landingMessage"),
      "Enter a nickname to create your room.",
      true,
    );
  }
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const response = await fetch(`${API}/api/rooms`, { method: "POST" });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Could not create a room.");
    connectAndJoin(result.code, name.slice(0, 24));
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
    name = $("joinNickname").value.trim();
  if (code.length !== 6)
    return message(
      $("landingMessage"),
      "Enter the six-character room code.",
      true,
    );
  if (!name)
    return message($("landingMessage"), "Enter a nickname to join.", true);
  connectAndJoin(code, name.slice(0, 24));
});

socket?.on("joined", (data) => {
  showRoom(data.code);
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
});
socket?.on("join_error", (data) => {
  clearActiveRoom();
  message($("landingMessage"), data.message, true);
});
socket?.on("connect_error", () =>
  message(
    $("landingMessage"),
    "Could not reach the room server. Start Flask, then reload the page.",
    true,
  ),
);
socket?.on("members", (data) => renderMembers(data.members));
socket?.on("file_available", (data) => {
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

// A reload creates a new Socket.IO connection. Rejoin the room remembered for
// this tab instead of showing the landing page again.
try {
  const savedRoom = JSON.parse(sessionStorage.getItem(ACTIVE_ROOM_KEY) || "null");
  if (savedRoom?.code && savedRoom?.name) {
    connectAndJoin(savedRoom.code, savedRoom.name);
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
  currentFile = file;
  $("noFile").classList.add("hidden");
  $("fileReady").classList.remove("hidden");
  $("fileChooserText").textContent = "Choose another video";
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fingerprint,
          name: file.name,
          uploader_id: socket?.id || "",
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
    form.append("uploader_id", socket?.id || "");
    const xhr = new XMLHttpRequest();
    const uploaded = await new Promise((resolve, reject) => {
      xhr.open("POST", `${API}/api/rooms/${currentCode}/upload`);
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
      const response = await fetch(`${API}/api/rooms/${currentCode}/download`);
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
  $("downloadPrompt").classList.add("hidden"),
);
$("copyCode").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentCode);
    message($("roomMessage"), "Room code copied.");
  } catch {
    message($("roomMessage"), `Share this code: ${currentCode}`);
  }
});

function sendPlayback() {
  if (syncing || !socket || !currentCode || !video.src) return;
  socket.emit("playback", {
    code: currentCode,
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
  if (!currentCode) return;

  const body = new FormData();
  body.append("client_id", clientId);
  body.append("socket_id", socket?.id || "");
  const leaveUrl = `${API}/api/rooms/${currentCode}/leave`;

  // sendBeacon can finish this small request while the page is closing.
  // The Socket.IO disconnect handler remains the fallback if it cannot send.
  if (!navigator.sendBeacon?.(leaveUrl, body)) {
    fetch(leaveUrl, { method: "POST", body, keepalive: true }).catch(() => {});
  }
});

$("leaveRoom").addEventListener("click", () => {
  clearActiveRoom();
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
  $("fileChooserText").textContent = "Choose video";
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
