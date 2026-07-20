// ═══════════════════════════════════════════════════════════════
//  OMIOR GATE SCAN — kiosk logic
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // Paste your deployed Apps Script Web App URL here (the one from
  // FaceKiosk_AppsScript.gs, NOT the existing attendance script).
  API_URL: "1QGr4psQIHkbWzskAxIQLvUAi7oQhVsyczixMex_1WHk",

  MODEL_URL: "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights",

  MATCH_THRESHOLD: 0.5,      // lower = stricter match (euclidean distance on 128d descriptor)
  DETECT_INTERVAL_MS: 350,   // how often we run detection while idle/detecting
  CONFIRM_HOLD_MS: 4000,     // how long a result stays on screen before resetting
  ROSTER_REFRESH_MS: 5 * 60 * 1000, // re-pull roster every 5 min
  QUEUE_RETRY_MS: 15000,     // retry failed scan uploads every 15s
  ENROLL_SHOTS: 5,

  LOCAL_ROSTER_KEY: "omior_roster_cache_v1",
  LOCAL_QUEUE_KEY:  "omior_scan_queue_v1",
};

// ── State ──────────────────────────────────────────────────────
let roster = [];              // [{name, embeddings:[Float32Array,...]}]
let armedOverride = null;     // "lunch_out" | "lunch_in" | "hd_entry" | "hd_exit" | null
let lastConfirmedAt = 0;
let detecting = false;
let stream = null;

const $ = (id) => document.getElementById(id);

// ── Boot ───────────────────────────────────────────────────────
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

    setBootMsg("Starting camera…");
    await startCamera();

    $("boot").classList.add("hide");
    startClock();
    startDetectionLoop();
    setInterval(loadRoster, CONFIG.ROSTER_REFRESH_MS);
    setInterval(flushQueue, CONFIG.QUEUE_RETRY_MS);
    updateQueueBadge();
    window.addEventListener("online",  () => setConn(true));
    window.addEventListener("offline", () => setConn(false));
    setConn(navigator.onLine);
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

function setConn(online) {
  const el = $("conn");
  el.classList.toggle("offline", !online);
  $("connText").textContent = online ? "online" : "offline — queuing scans";
}

// ── Camera ─────────────────────────────────────────────────────
async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  const video = $("video");
  video.srcObject = stream;
  await video.play();
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
    setConn(true);
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
    setConn(false);
  }
}

// ── Detection loop ────────────────────────────────────────────
function startDetectionLoop() {
  setInterval(async () => {
    if (detecting) return;
    // pause detection while a result card is showing
    if (Date.now() - lastConfirmedAt < CONFIG.CONFIRM_HOLD_MS && lastConfirmedAt !== 0) return;

    detecting = true;
    try { await runDetection(); }
    catch (err) { console.error("detection error", err); }
    detecting = false;
  }, CONFIG.DETECT_INTERVAL_MS);
}

async function runDetection() {
  const video = $("video");
  if (video.readyState < 2) return;

  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
  const detection = await faceapi
    .detectSingleFace(video, options)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    setCamState("idle");
    setStatusText("Position your face in frame");
    return;
  }

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
  lastConfirmedAt = Date.now();
  setCamState("match");

  const scanType = inferScanType();
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

  disarmOverride();
  scheduleReset();
}

function showUnknown() {
  lastConfirmedAt = Date.now();
  setCamState("unknown");
  setStatusText("Face not recognized");
  $("resultName").textContent = "Not recognized";
  $("resultMeta").textContent = "Try again, or ask staff to enroll.";
  const actionEl = $("resultAction");
  actionEl.textContent = "✕ Not saved";
  actionEl.style.background = "var(--red-dim)";
  actionEl.style.color = "var(--red)";
  $("resultCard").classList.add("show");
  scheduleReset();
}

function scheduleReset() {
  setTimeout(() => {
    $("resultCard").classList.remove("show");
    setCamState("idle");
    setStatusText("Position your face in frame");
    lastConfirmedAt = 0;
  }, CONFIG.CONFIRM_HOLD_MS);
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

// ── Override buttons ──────────────────────────────────────────
document.querySelectorAll(".ovBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.type;
    if (armedOverride === type) {
      disarmOverride();
    } else {
      document.querySelectorAll(".ovBtn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      armedOverride = type;
      $("armedNote").textContent = "Armed: " + scanTypeLabel(type) + " — scan a face now";
    }
  });
});

function disarmOverride() {
  armedOverride = null;
  document.querySelectorAll(".ovBtn").forEach(b => b.classList.remove("active"));
  $("armedNote").innerHTML = "&nbsp;";
}

// ── Offline queue (for scan events) ───────────────────────────
function getQueue() {
  try { return JSON.parse(localStorage.getItem(CONFIG.LOCAL_QUEUE_KEY) || "[]"); }
  catch { return []; }
}
function setQueue(q) {
  localStorage.setItem(CONFIG.LOCAL_QUEUE_KEY, JSON.stringify(q));
  updateQueueBadge();
}
function updateQueueBadge() { $("queueCount").textContent = getQueue().length; }

async function queueScan(entry) {
  const q = getQueue();
  q.push(entry);
  setQueue(q);
  flushQueue();
}

async function flushQueue() {
  let q = getQueue();
  if (q.length === 0) return;
  if (!navigator.onLine) { setConn(false); return; }

  const remaining = [];
  for (const entry of q) {
    try {
      const res = await fetch(CONFIG.API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight on Apps Script
        body: JSON.stringify({ action: "scan", ...entry }),
      });
      const rawText = await res.text();
      console.log("Scan POST response:", res.status, rawText);
      let data;
      try { data = JSON.parse(rawText); }
      catch { throw new Error("Non-JSON response (status " + res.status + "): " + rawText.slice(0, 200)); }
      if (!data.ok) throw new Error(data.error || "scan write failed");
    } catch (err) {
      console.warn("Scan upload failed, will retry:", err.message);
      showToast("Sync error: " + err.message);
      remaining.push(entry);
    }
  }
  setQueue(remaining);
  setConn(remaining.length === 0 || navigator.onLine);
  if (q.length > 0 && remaining.length < q.length) showToast(`Synced ${q.length - remaining.length} pending scan(s)`);
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
