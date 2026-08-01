// ═══════════════════════════════════════════════════════════════
//  OMIOR GATE SCAN — kiosk logic
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // Paste your deployed Apps Script Web App URL here (the one from
  // FaceKiosk_AppsScript.gs, NOT the existing attendance script).
  API_URL: "https://script.google.com/macros/s/AKfycbzx1d3ibfzBuMiwBOmM2R6FKr61kiDiGeSZF2jsSIj55u5cu-xhVqVtyQRzfKZb8hGr1A/exec",

  MODEL_URL: "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights",

  MATCH_THRESHOLD: 0.5,      // lower = stricter match (euclidean distance on 128d descriptor)
  DETECT_INTERVAL_MS: 350,   // how often we check for a face while a session is active
  CONFIRM_HOLD_MS: 4000,     // how long the result card stays visible before the camera shuts off
  CAMERA_IDLE_TIMEOUT_MS: 25000, // if a session is started but no face ever appears, shut off anyway
  ROSTER_REFRESH_MS: 5 * 60 * 1000, // re-pull roster every 5 min
  QUEUE_RETRY_MS: 15000,     // retry failed scan uploads every 15s
  ENROLL_SHOTS: 5,

  // ── Backend reachability ────────────────────────────────────────
  // navigator.onLine only tells us the device has SOME network
  // interface up — it says nothing about whether our specific
  // API_URL is actually reachable. We separately ping the backend
  // itself so "online" reflects reality, not just a wifi icon.
  PING_INTERVAL_MS: 30000,
  PING_TIMEOUT_MS: 6000,

  // ── Offline queue ────────────────────────────────────────────
  MAX_QUEUE_SIZE: 20,       // max scans held locally while offline
  DUPE_WINDOW_MS: 5000,     // ignore a queue push that exactly repeats one already queued

  LOCAL_ROSTER_KEY: "omior_roster_cache_v1",
  LOCAL_QUEUE_KEY:  "omior_scan_queue_v1",
};

// ── State ──────────────────────────────────────────────────────
let roster = [];              // [{name, embeddings:[Float32Array,...]}]
let armedOverride = null;     // "lunch_out" | "lunch_in" | "hd_entry" | "hd_exit" | null
let stream = null;
let cameraOn = false;         // is the camera hardware currently live?
let detecting = false;        // guards against overlapping detectSingleFace calls
let detectTimer = null;       // interval id for the active-session detection loop
let idleTimeoutTimer = null;  // auto shut-off if a session is started but nobody shows up
let flushing = false;         // prevents overlapping flushQueue runs
let backendReachable = true;  // last known result of actually reaching CONFIG.API_URL

const $ = (id) => document.getElementById(id);

// ── Boot ───────────────────────────────────────────────────────
// NOTE: the camera is NOT started here. It only turns on when someone
// taps the camera area or one of the action buttons, and turns back
// off the instant a face has been processed. See beginScanSession /
// endScanSession below.
(async function init() {
  try {
    setBootMsg("Loading recognition models…");
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(CONFIG.MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(CONFIG.MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(CONFIG.MODEL_URL),
    ]);

    setBootMsg("Loading staff roster…");
    await loadRoster();

    $("boot").classList.add("hide");
    startClock();
    goIdle("Tap to scan");

    setInterval(loadRoster, CONFIG.ROSTER_REFRESH_MS);
    setInterval(flushQueue, CONFIG.QUEUE_RETRY_MS);
    setInterval(pingBackend, CONFIG.PING_INTERVAL_MS);
    updateQueueBadge();
    window.addEventListener("online",  () => { updateConnDisplay(); pingBackend(); flushQueue(); });
    window.addEventListener("offline", () => updateConnDisplay());
    updateConnDisplay();
    pingBackend();

    // Tapping the camera area itself is the "any button" for a plain
    // login/logout scan when the camera is currently off.
    $("camWrap").addEventListener("click", () => {
      if (!cameraOn) beginScanSession(null);
    });
  } catch (err) {
    setBootMsg("Setup error: " + err.message + " — reload to retry.");
    console.error(err);
  }
})();

function setBootMsg(msg) { $("bootMsg").textContent = msg; }

// ── Clock ──────────────────────────────────────────────────────
function startClock() {
  const tick = () => {
    $("clock").textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

// ── Connection status: device network AND backend reachability ──
// navigator.onLine can say "online" while CONFIG.API_URL is actually
// unreachable (wrong URL, deployment down, Google-side hiccup). We
// track both separately so the status shown actually matches whether
// scans can sync — not just whether the phone has a network icon.
function updateConnDisplay() {
  const el = $("conn");
  const deviceOnline = navigator.onLine;
  const healthy = deviceOnline && backendReachable;
  el.classList.toggle("offline", !healthy);

  if (!deviceOnline) {
    $("connText").textContent = "offline — queuing scans";
  } else if (!backendReachable) {
    $("connText").textContent = "backend unreachable — queuing scans";
  } else {
    $("connText").textContent = "online";
  }
}

// Any code that just confirmed (or just failed) an actual round-trip
// to the backend — a real scan, a roster fetch, a ping — should call
// this instead of guessing from navigator.onLine alone.
function markBackendReachable(reachable) {
  backendReachable = reachable;
  updateConnDisplay();
}

async function pingBackend() {
  if (!navigator.onLine) { updateConnDisplay(); return; }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.PING_TIMEOUT_MS);
    const res = await fetch(CONFIG.API_URL + "?action=ping", {
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    markBackendReachable(!!(data && data.ok));
  } catch (err) {
    markBackendReachable(false);
  }
}

// ── Camera hardware ────────────────────────────────────────────
async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  const video = $("video");
  video.srcObject = stream;
  await video.play();
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  $("video").srcObject = null;
}

// ── Roster ─────────────────────────────────────────────────────
async function loadRoster() {
  try {
    const res = await fetch(CONFIG.API_URL + "?action=roster", { cache: "no-store" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "roster fetch failed");

    roster = data.staff.map(s => ({
      name: s.name,
      embeddings: s.embeddings.map(e => new Float32Array(e)),
    }));
    localStorage.setItem(CONFIG.LOCAL_ROSTER_KEY, JSON.stringify(data.staff));
    markBackendReachable(true);
  } catch (err) {
    console.warn("Roster refresh failed, using cache if available:", err.message);
    const cached = localStorage.getItem(CONFIG.LOCAL_ROSTER_KEY);
    if (cached && roster.length === 0) {
      const parsed = JSON.parse(cached);
      roster = parsed.map(s => ({
        name: s.name,
        embeddings: s.embeddings.map(e => new Float32Array(e)),
      }));
    }
    markBackendReachable(false);
  }
}

// ── Scan session lifecycle ─────────────────────────────────────
// A "session" = camera on, actively looking for exactly one face.
// The instant a face is found (matched or not), the session ends and
// the camera shuts off. Nothing restarts it automatically — the next
// person must tap the camera area or an action button.
async function beginScanSession(type) {
  if (cameraOn) return; // a session is already running

  armedOverride = type;
  if (type) {
    $("armedNote").textContent = "Armed: " + scanTypeLabel(type) + " — scan a face now";
  } else {
    $("armedNote").innerHTML = "&nbsp;";
  }

  try {
    await startCamera();
  } catch (err) {
    setStatusText("Camera error: " + err.message);
    return;
  }

  cameraOn = true;
  setCamState("idle");
  setStatusText("Position your face in frame");

  clearTimeout(idleTimeoutTimer);
  idleTimeoutTimer = setTimeout(() => {
    if (cameraOn) endScanSession("No face detected — tap to try again.");
  }, CONFIG.CAMERA_IDLE_TIMEOUT_MS);

  detectTimer = setInterval(async () => {
    if (detecting) return;
    detecting = true;
    try { await runDetection(); }
    catch (err) { console.error("detection error", err); }
    detecting = false;
  }, CONFIG.DETECT_INTERVAL_MS);
}

function endScanSession(idleMsg) {
  clearInterval(detectTimer);
  detectTimer = null;
  clearTimeout(idleTimeoutTimer);
  stopCamera();
  cameraOn = false;
  disarmOverride();
  $("resultCard").classList.remove("show");
  goIdle(idleMsg || "Tap to scan");
}

function goIdle(msg) {
  setCamState("idle");
  setStatusText(msg);
}

async function runDetection() {
  const video = $("video");
  if (video.readyState < 2) return;

  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
  const detection = await faceapi
    .detectSingleFace(video, options)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) return; // nobody in frame yet — keep the session running

  // A face was found — stop looking immediately. Only one face is
  // ever processed per session, by design.
  clearInterval(detectTimer);
  detectTimer = null;
  clearTimeout(idleTimeoutTimer);

  setCamState("detect");
  setStatusText("Recognizing…");

  const match = matchDescriptor(detection.descriptor);
  if (match) {
    confirmMatch(match.name, match.distance);
  } else {
    showUnknown();
  }
}

function matchDescriptor(descriptor) {
  let best = null;
  for (const person of roster) {
    for (const emb of person.embeddings) {
      const dist = faceapi.euclideanDistance(descriptor, emb);
      if (dist < CONFIG.MATCH_THRESHOLD && (!best || dist < best.distance)) {
        best = { name: person.name, distance: dist };
      }
    }
  }
  return best;
}

// ── Result handling ───────────────────────────────────────────
function inferScanType() {
  if (armedOverride) return armedOverride;
  // default: treat as ordinary OT login/logout — backend infers
  // login vs logout by time, same as the QR flow does today.
  return "ot";
}

function scanTypeLabel(type) {
  return {
    ot:        "Login / Logout",
    lunch_out: "Lunch Out",
    lunch_in:  "Lunch In",
    hd_entry:  "Half Day — Entry",
    hd_exit:   "Half Day — Exit",
  }[type] || type;
}

function confirmMatch(name, distance) {
  const scanType = inferScanType();
  setCamState("match");

  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-GB", { hour12: false });

  $("resultName").textContent = name;
  $("resultMeta").innerHTML = `<b>⏰ ${timeStr}</b> &nbsp;·&nbsp; ${scanTypeLabel(scanType)}`;
  const actionEl = $("resultAction");
  actionEl.textContent = "✓ Recorded";
  actionEl.style.background = "var(--green-dim)";
  actionEl.style.color = "var(--green)";
  $("resultCard").classList.add("show");
  setStatusText("Matched");

  queueScan({
    name,
    scanType: mapScanTypeForApi(scanType),
    timestamp: now.toISOString(),
  });

  setTimeout(() => endScanSession(), CONFIG.CONFIRM_HOLD_MS);
}

function showUnknown() {
  setCamState("unknown");
  setStatusText("Face not recognized");
  $("resultName").textContent = "Not recognized";
  $("resultMeta").textContent = "Tap the camera to try again, or ask staff to enroll.";
  const actionEl = $("resultAction");
  actionEl.textContent = "✕ Not saved";
  actionEl.style.background = "var(--red-dim)";
  actionEl.style.color = "var(--red)";
  $("resultCard").classList.add("show");

  setTimeout(() => endScanSession(), CONFIG.CONFIRM_HOLD_MS);
}

function mapScanTypeForApi(type) {
  // Backend only distinguishes: ot, lunch, hd_entry, hd_exit.
  // Lunch direction (out vs in) is inferred server-side from whether
  // it's the person's 1st or 2nd lunch scan today — same as QR flow.
  if (type === "lunch_out" || type === "lunch_in") return "lunch";
  return type; // ot, hd_entry, hd_exit pass through unchanged
}

function setCamState(state) {
  const el = $("camWrap");
  el.classList.remove("state-idle", "state-detect", "state-match", "state-unknown");
  el.classList.add("state-" + state);
}
function setStatusText(txt) { $("statusText").textContent = txt; }

// ── Action buttons (Lunch Out/In, Half Day In/Out) ─────────────
// Any of these is also a valid "wake the camera up" tap. If the
// camera is already on, pressing one just re-arms the type; pressing
// the currently-armed one again cancels the session outright.
document.querySelectorAll(".ovBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.type;

    if (cameraOn) {
      if (armedOverride === type) {
        endScanSession();
        return;
      }
      armedOverride = type;
      document.querySelectorAll(".ovBtn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      $("armedNote").textContent = "Armed: " + scanTypeLabel(type) + " — scan a face now";
      return;
    }

    document.querySelectorAll(".ovBtn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    beginScanSession(type);
  });
});

function disarmOverride() {
  armedOverride = null;
  document.querySelectorAll(".ovBtn").forEach(b => b.classList.remove("active"));
  $("armedNote").innerHTML = "&nbsp;";
}

// ── Offline queue (for scan events) ───────────────────────────
//
//  - Every entry gets a unique id.
//  - On success, only that ONE entry is removed, and it's removed by
//    re-reading storage fresh at that moment — not by writing back a
//    stale in-memory snapshot. A scan added WHILE a flush is in
//    progress can never be silently wiped out.
//  - A `flushing` lock stops two flush passes (e.g. the 15s timer and
//    a just-queued scan) from running concurrently and double-sending.
//  - The queue is capped at MAX_QUEUE_SIZE; if it's ever exceeded the
//    oldest entry is dropped (with a visible warning).
//  - A short dedupe window blocks queueing an exact repeat as an
//    extra safety net.

function getQueue() {
  try { return JSON.parse(localStorage.getItem(CONFIG.LOCAL_QUEUE_KEY) || "[]"); }
  catch { return []; }
}

function saveQueue(q) {
  try {
    localStorage.setItem(CONFIG.LOCAL_QUEUE_KEY, JSON.stringify(q));
  } catch (err) {
    console.error("Queue save failed:", err.message);
    showToast("Local storage error — a scan may not have saved");
  }
  updateQueueBadge();
}

function updateQueueBadge() { $("queueCount").textContent = getQueue().length; }

function makeScanId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

async function queueScan(entry) {
  entry.id = makeScanId();

  const q = getQueue();

  const isDupe = q.some(e =>
    e.name === entry.name &&
    e.scanType === entry.scanType &&
    Math.abs(new Date(e.timestamp) - new Date(entry.timestamp)) < CONFIG.DUPE_WINDOW_MS
  );
  if (isDupe) {
    console.warn("Skipped duplicate queue entry for", entry.name);
    return;
  }

  q.push(entry);

  while (q.length > CONFIG.MAX_QUEUE_SIZE) {
    const dropped = q.shift();
    console.warn("Offline queue full — dropped oldest scan:", dropped);
    showToast(`Offline queue full (${CONFIG.MAX_QUEUE_SIZE}) — oldest scan dropped`);
  }

  saveQueue(q);
  flushQueue();
}

async function flushQueue() {
  if (flushing) return;
  if (!navigator.onLine) { updateConnDisplay(); return; }

  const q = getQueue();
  if (q.length === 0) return;

  flushing = true;
  let sentCount = 0;

  try {
    for (const entry of q) {
      try {
        const res = await fetch(CONFIG.API_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight on Apps Script
          body: JSON.stringify({ action: "scan", ...entry }),
        });
        const rawText = await res.text();
        let data;
        try { data = JSON.parse(rawText); }
        catch { throw new Error("Non-JSON response (status " + res.status + "): " + rawText.slice(0, 200)); }
        if (!data.ok) throw new Error(data.error || "scan write failed");

        // Remove only this entry, from whatever is currently in storage —
        // never overwrite the whole queue with a stale snapshot.
        const current = getQueue();
        saveQueue(current.filter(e => e.id !== entry.id));
        sentCount++;
        markBackendReachable(true);
      } catch (err) {
        console.warn("Scan upload failed, will retry:", err.message);
        showToast("Sync error: " + err.message);
        markBackendReachable(false);
        // leave this entry exactly where it is in storage; try again next pass
      }
    }
  } finally {
    flushing = false;
  }

  if (sentCount > 0) showToast(`Synced ${sentCount} pending scan(s)`);
  updateQueueBadge();
}

// ── Toast ──────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
}

// ── Enroll modal ───────────────────────────────────────────────
// (unchanged — uses its own independent camera stream, unrelated to
// the main scan session above)
let enrollStream = null;
let capturedDescriptors = [];

$("enrollLink").addEventListener("click", openEnroll);
$("enrollCancel").addEventListener("click", closeEnroll);
$("enrollCapture").addEventListener("click", captureEnrollShot);

async function openEnroll() {
  $("enrollOverlay").classList.add("show");
  $("enrollName").value = "";
  capturedDescriptors = [];
  updateEnrollDots();
  $("enrollStatus").textContent = "";
  $("enrollCapture").textContent = "Capture photo";
  $("enrollCapture").disabled = false;
  try {
    enrollStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 480 } },
      audio: false,
    });
    $("enrollVideo").srcObject = enrollStream;
    await $("enrollVideo").play();
  } catch (err) {
    $("enrollStatus").textContent = "Camera error: " + err.message;
  }
}

function closeEnroll() {
  $("enrollOverlay").classList.remove("show");
  if (enrollStream) {
    enrollStream.getTracks().forEach(t => t.stop());
    enrollStream = null;
  }
}

function updateEnrollDots() {
  document.querySelectorAll(".capDot").forEach((d, i) => {
    d.classList.toggle("done", i < capturedDescriptors.length);
  });
}

async function captureEnrollShot() {
  const name = $("enrollName").value.trim();
  if (!name) {
    $("enrollStatus").textContent = "Enter the staff member's name first.";
    return;
  }

  $("enrollCapture").disabled = true;
  $("enrollStatus").textContent = "Capturing…";

  const video = $("enrollVideo");
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
  const detection = await faceapi
    .detectSingleFace(video, options)
    .withFaceLandmarks()
    .withFaceDescriptor();

  $("enrollCapture").disabled = false;

  if (!detection) {
    $("enrollStatus").textContent = "No face detected — try again, ensure good lighting.";
    return;
  }

  capturedDescriptors.push(Array.from(detection.descriptor));
  updateEnrollDots();

  if (capturedDescriptors.length >= CONFIG.ENROLL_SHOTS) {
    $("enrollStatus").textContent = "Saving to roster…";
    $("enrollCapture").textContent = "Capture photo";
    await submitEnrollment(name, capturedDescriptors);
  } else {
    $("enrollStatus").textContent = `${capturedDescriptors.length}/${CONFIG.ENROLL_SHOTS} captured — change angle slightly, capture again.`;
  }
}

async function submitEnrollment(name, embeddings) {
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "enroll", name, embeddings }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "enroll failed");

    $("enrollStatus").textContent = data.knownInPersonSheet
      ? "✓ Enrolled successfully."
      : "✓ Enrolled — note: name not found in Person Name sheet, add it there too.";
    await loadRoster();
    setTimeout(closeEnroll, 1600);
  } catch (err) {
    $("enrollStatus").textContent = "Save failed: " + err.message + " — will not retry automatically, try again.";
  }
}
