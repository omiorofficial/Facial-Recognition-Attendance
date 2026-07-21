// ═══════════════════════════════════════════════════════════════
//  OMIOR GATE SCAN — kiosk logic
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // Paste your deployed Apps Script Web App URL here (the one from
  // FaceKiosk_AppsScript.gs, NOT the existing attendance script).
  API_URL: "https://script.google.com/macros/s/AKfycbzx1d3ibfzBuMiwBOmM2R6FKr61kiDiGeSZF2jsSIj55u5cu-xhVqVtyQRzfKZb8hGr1A/exec",

  MODEL_URL: "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights",

  MATCH_THRESHOLD: 0.5,      // lower = stricter match (euclidean distance on 128d descriptor)
  DETECT_INTERVAL_MS: 350,   // how often we run detection during an active scan session
  CONFIRM_HOLD_MS: 4000,     // how long a result stays on screen before resetting
  ROSTER_REFRESH_MS: 5 * 60 * 1000, // re-pull roster every 5 min
  QUEUE_RETRY_MS: 15000,     // retry failed scan uploads every 15s
  ENROLL_SHOTS: 5,

  // How long a scan session (camera on, waiting for a face) stays open
  // after a button press with no match found, before auto-cancelling.
  SESSION_TIMEOUT_MS: 20000,

  // Minimum gap between two logged scans for the SAME person, regardless
  // of scan type or page reloads. Blocks accidental double-scans (e.g.
  // camera catching the same face twice, a page refresh right after a
  // scan, or someone lingering in frame).
  DUPLICATE_SCAN_COOLDOWN_MS: 20000,

  // ── Adaptive face learning ──────────────────────────────────
  // Silently keeps each person's stored face samples up to date
  // (hair changes, glasses, beard growth, weight change, etc.) so
  // matching stays fast and accurate without re-enrolling manually.
  ADAPTIVE_LEARNING_ENABLED: true,
  ADAPTIVE_MAX_DISTANCE: 0.32,      // stricter than MATCH_THRESHOLD — only learn from a very confident match
  ADAPTIVE_MAX_EMBEDDINGS: 8,       // cap samples kept per person (oldest dropped first)
  ADAPTIVE_MIN_INTERVAL_MS: 24 * 60 * 60 * 1000, // at most once per person per day

  LOCAL_ROSTER_KEY: "omior_roster_cache_v1",
  LOCAL_QUEUE_KEY:  "omior_scan_queue_v1",
  LOCAL_RECENT_KEY: "omior_recent_submissions_v1",
  LOCAL_ADAPT_KEY:  "omior_adaptive_learn_last_v1",
};

// ── State ──────────────────────────────────────────────────────
let roster = [];              // [{name, embeddings:[Float32Array,...]}]
let activeScanType = null;    // "ot" | "lunch" | "hd_entry" | "hd_exit" | null — set only while a button-triggered session is live
let lastConfirmedAt = 0;
let detecting = false;
let stream = null;
let detectionTimer = null;    // interval handle for the current scan session (null = camera off / idle)
let sessionTimeoutTimer = null;

// name -> timestamp ms of last successful scan. Persisted in localStorage
// so the cooldown survives page reloads (a common cause of near-instant
// duplicate scans on a kiosk that auto-refreshes).
function loadRecentSubmissions() {
  try { return JSON.parse(localStorage.getItem(CONFIG.LOCAL_RECENT_KEY) || "{}"); }
  catch { return {}; }
}
function saveRecentSubmissions(obj) {
  localStorage.setItem(CONFIG.LOCAL_RECENT_KEY, JSON.stringify(obj));
}
let recentSubmissions = loadRecentSubmissions();

const $ = (id) => document.getElementById(id);

// ── Boot ───────────────────────────────────────────────────────
// NOTE: camera is NOT started here anymore. It only turns on when a
// staff member presses one of the 4 action buttons (OT / Lunch /
// Half Day Entry / Half Day Exit), and turns off again once that
// scan session ends (match found, or timeout, or button pressed again).
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
    setCamState("idle");
    setStatusText("Select an action to begin");
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
  if (stream) return; // already on
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
  const video = $("video");
  if (video) video.srcObject = null;
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

// ── Scan session ───────────────────────────────────────────────
// A "session" = camera on + actively looking for a face for ONE
// specific scan type. Started only by a button press, stopped as
// soon as we get a match (or the person cancels / it times out).
async function startScanSession(type) {
  // Pressing the same button again cancels the session instead of
  // restarting it.
  if (activeScanType === type) {
    endScanSession();
    return;
  }

  endScanSession(); // clear out any other session first

  activeScanType = type;
  document.querySelectorAll(".ovBtn").forEach(b => {
    b.classList.toggle("active", b.dataset.type === type);
  });
  $("armedNote").textContent = scanTypeLabel(type) + " — opening camera…";

  try {
    await startCamera();
  } catch (err) {
    $("armedNote").textContent = "Camera error: " + err.message;
    activeScanType = null;
    document.querySelectorAll(".ovBtn").forEach(b => b.classList.remove("active"));
    return;
  }

  setCamState("idle");
  setStatusText("Position your face in frame");
  $("armedNote").textContent = scanTypeLabel(type) + " — scan a face now";

  detectionTimer = setInterval(async () => {
    if (detecting) return;
    detecting = true;
    try { await runDetection(); }
    catch (err) { console.error("detection error", err); }
    detecting = false;
  }, CONFIG.DETECT_INTERVAL_MS);

  sessionTimeoutTimer = setTimeout(() => {
    if (activeScanType === type) {
      $("armedNote").textContent = "Timed out — tap the button to try again.";
      endScanSession();
    }
  }, CONFIG.SESSION_TIMEOUT_MS);
}

function endScanSession() {
  if (detectionTimer) { clearInterval(detectionTimer); detectionTimer = null; }
  if (sessionTimeoutTimer) { clearTimeout(sessionTimeoutTimer); sessionTimeoutTimer = null; }
  activeScanType = null;
  document.querySelectorAll(".ovBtn").forEach(b => b.classList.remove("active"));
  stopCamera();
}

async function runDetection() {
  const video = $("video");
  if (video.readyState < 2) return;

  // A result was just confirmed — don't let an in-flight detection
  // that resolves afterward touch the DOM and wipe the confirmed card.
  if (lastConfirmedAt !== 0 && Date.now() - lastConfirmedAt < CONFIG.CONFIRM_HOLD_MS) return;

  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
  const detection = await faceapi
    .detectSingleFace(video, options)
    .withFaceLandmarks()
    .withFaceDescriptor();

  // Re-check after the await — a confirm may have happened while this
  // scan was running.
  if (lastConfirmedAt !== 0 && Date.now() - lastConfirmedAt < CONFIG.CONFIRM_HOLD_MS) return;
  if (!activeScanType) return; // session was cancelled while this was running

  if (!detection) {
    setCamState("idle");
    setStatusText("Position your face in frame");
    return;
  }

  setCamState("detect");

  const match = matchDescriptor(detection.descriptor);
  if (!match) {
    showUnknown();
    return;
  }

  // Button was already pressed before the camera ever turned on, so we
  // confirm the moment we get a confident match — no waiting/grace period.
  confirmMatch(match.name, match.distance, detection.descriptor);
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

// ── Adaptive face learning ────────────────────────────────────
function loadAdaptTimestamps() {
  try { return JSON.parse(localStorage.getItem(CONFIG.LOCAL_ADAPT_KEY) || "{}"); }
  catch { return {}; }
}
function saveAdaptTimestamps(obj) {
  localStorage.setItem(CONFIG.LOCAL_ADAPT_KEY, JSON.stringify(obj));
}
let adaptTimestamps = loadAdaptTimestamps();

// Called after a CONFIDENT confirmed match. Folds the just-seen face into
// that person's stored samples so drift over time (haircuts, glasses,
// beard, weight) doesn't degrade matching. Never blocks the scan UI —
// runs quietly in the background, and never touches the roster on a
// weak/borderline match.
async function maybeAdaptEmbedding(name, distance, descriptor) {
  if (!CONFIG.ADAPTIVE_LEARNING_ENABLED) return;
  if (distance > CONFIG.ADAPTIVE_MAX_DISTANCE) return; // not confident enough to learn from

  const lastAt = adaptTimestamps[name] || 0;
  if (Date.now() - lastAt < CONFIG.ADAPTIVE_MIN_INTERVAL_MS) return; // throttle to ~once/day/person

  const person = roster.find(p => p.name === name);
  if (!person) return;

  // Build the updated sample set: existing + new, capped FIFO so both
  // older and newer appearances stay represented.
  const updated = [...person.embeddings, descriptor];
  while (updated.length > CONFIG.ADAPTIVE_MAX_EMBEDDINGS) updated.shift();

  const embeddingsArr = updated.map(e => Array.from(e));

  try {
    const res = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "enroll", name, embeddings: embeddingsArr }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "adaptive enroll failed");

    // Reflect locally right away so this session benefits immediately.
    person.embeddings = updated;
    adaptTimestamps[name] = Date.now();
    saveAdaptTimestamps(adaptTimestamps);
  } catch (err) {
    // Non-critical — just skip silently, no toast, don't interrupt the kiosk.
    console.warn("Adaptive face update failed:", err.message);
  }
}

// ── Result handling ───────────────────────────────────────────
function scanTypeLabel(type) {
  return {
    ot:        "Overtime (Login / Logout)",
    lunch:     "Lunch",
    hd_entry:  "Half Day — Entry",
    hd_exit:   "Half Day — Exit",
  }[type] || type;
}

function confirmMatch(name, distance, descriptor) {
  const scanType = activeScanType || "ot";

  // Guard: same person scanned again too soon — likely a duplicate
  // (lingering in frame, camera re-trigger, or a page reload right
  // after the last scan). Show it as recognized but don't log again.
  const lastAt = recentSubmissions[name] || 0;
  if (lastAt && Date.now() - lastAt < CONFIG.DUPLICATE_SCAN_COOLDOWN_MS) {
    lastConfirmedAt = Date.now();
    setCamState("match");
    $("resultName").textContent = name;
    $("resultMeta").textContent = "Already scanned just now — skipping duplicate";
    const actionEl = $("resultAction");
    actionEl.textContent = "⚠ Duplicate";
    actionEl.style.background = "var(--red-dim)";
    actionEl.style.color = "var(--red)";
    $("resultCard").classList.add("show");
    setStatusText("Duplicate scan ignored");
    endScanSession();
    scheduleReset();
    return;
  }

  lastConfirmedAt = Date.now();
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

  recentSubmissions[name] = Date.now();
  saveRecentSubmissions(recentSubmissions);

  queueScan({
    name,
    scanType, // already "ot" | "lunch" | "hd_entry" | "hd_exit" — matches backend directly
    timestamp: now.toISOString(),
  });

  if (descriptor) maybeAdaptEmbedding(name, distance, descriptor);

  // Scan done — close the camera immediately. Staff presses a button
  // again for the next scan.
  endScanSession();
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
    lastConfirmedAt = 0;
    // Only reset the idle status text/cam state if no NEW session has
    // started in the meantime (camera may already be off/on again).
    if (!activeScanType) {
      setCamState("idle");
      setStatusText("Select an action to begin");
    }
  }, CONFIG.CONFIRM_HOLD_MS);
}

function setCamState(state) {
  const el = $("camWrap");
  el.classList.remove("state-idle", "state-detect", "state-match", "state-unknown");
  el.classList.add("state-" + state);
}
function setStatusText(txt) { $("statusText").textContent = txt; }

// ── Action buttons — Overtime / Lunch / Half Day Entry / Half Day Exit ──
// Each button press: (1) opens the camera, (2) scans, (3) logs, (4)
// closes the camera again. Pressing the currently-active button cancels
// the session instead.
document.querySelectorAll(".ovBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    startScanSession(btn.dataset.type);
  });
});

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

let flushing = false;
async function flushQueue() {
  if (flushing) return; // a flush is already in progress — don't double-send the same entries
  flushing = true;
  try {
    await flushQueueInner();
  } finally {
    flushing = false;
  }
}

async function flushQueueInner() {
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
