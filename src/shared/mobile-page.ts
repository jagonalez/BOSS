/**
 * The mobile site, served as one self-contained document — no build step,
 * no external assets, works offline-cached once loaded. Scope: review and
 * steer — threads, replies, stop, permissions, automations. Never
 * configuration.
 *
 * It speaks one BackendRequest protocol over either of two transports:
 *
 *   local — POST /api/request and SSE /api/events, reached over loopback or
 *           Tailscale. This is the original path and still the default.
 *   relay — an encrypted WebSocket to the fly.io relay, used when the phone
 *           has paired by QR code. Frames are sealed with a key derived from
 *           the pairing secret, so the relay forwards bytes it cannot read.
 *
 * `api()` and `listen()` hide the choice, so the UI code below is identical
 * on both paths. A native wrapper can load this page unchanged.
 */
export const MOBILE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0d10">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="apple-touch-icon" href="./icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="BOSS">
<title>BOSS</title>
<style>
:root {
  --bg: #0b0d10; --pane: #14171d; --inset: #1a1e26; --line: #242a35;
  --text: #e6e9ee; --muted: #9aa3b2; --faint: #6b7280;
  --accent: #7aa2f7; --green: #9ece6a; --red: #f7768e; --yellow: #e0af68;
}
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font: 15px/1.5 -apple-system, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  padding-bottom: env(safe-area-inset-bottom);
  overflow-x: hidden; max-width: 100vw;
  overflow-wrap: anywhere;
}
main { max-width: 100%; }
#app { display: flex; flex-direction: column; min-height: 100dvh; }
header {
  position: sticky; top: 0; z-index: 5;
  display: flex; align-items: center; gap: 10px;
  padding: calc(10px + env(safe-area-inset-top)) 14px 10px;
  background: rgba(11,13,16,0.92); backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--line);
}
header h1 { font-size: 15px; font-weight: 650; letter-spacing: 0.02em; flex: 1; }
header button { background: none; border: none; color: var(--accent); font-size: 14px; padding: 4px 6px; }
main { flex: 1; padding: 12px 12px 90px; }
.tabs {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 5;
  display: flex; border-top: 1px solid var(--line);
  background: rgba(11,13,16,0.95); backdrop-filter: blur(10px);
  padding-bottom: env(safe-area-inset-bottom);
}
.tabs button {
  flex: 1; padding: 12px 0 10px; background: none; border: none;
  color: var(--muted); font-size: 12.5px; font-weight: 600;
}
.tabs button.active { color: var(--accent); }
.card {
  display: block; width: 100%; text-align: left;
  background: var(--pane); border: 1px solid var(--line); border-radius: 12px;
  padding: 12px; margin-bottom: 10px; color: var(--text);
}
.card .title { font-weight: 600; font-size: 14.5px; }
.card .sub { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.row { display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: 0 0 auto; }
.dot.busy { background: var(--green); animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
.badge {
  font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 2px 8px; border-radius: 999px; background: var(--inset); color: var(--muted);
}
.badge.success { color: var(--green); } .badge.failure, .badge.timeout { color: var(--red); }
.badge.running { color: var(--green); }
.btn {
  border: 1px solid var(--line); background: var(--inset); color: var(--text);
  border-radius: 9px; padding: 8px 14px; font-size: 13.5px; font-weight: 600;
}
.btn.primary { background: var(--accent); border-color: var(--accent); color: #0b0d10; }
.btn.danger { color: var(--red); }
.msg { margin-bottom: 14px; }
.msg .who { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); margin-bottom: 3px; }
.msg.user .body { background: var(--inset); border-radius: 12px; padding: 10px 12px; }
.msg .body { white-space: pre-wrap; word-break: break-word; font-size: 14.5px; }
.msg .steps { color: var(--faint); font-size: 12px; margin: 4px 0; }
.composer {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 6;
  display: flex; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  background: rgba(11,13,16,0.95); border-top: 1px solid var(--line);
}
.composer textarea {
  flex: 1; resize: none; background: var(--inset); color: var(--text);
  border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px;
  font: inherit; max-height: 110px;
}
/* iOS auto-zooms focused inputs below 16px; keep every input at 16px. */
input, textarea { font-size: 16px !important; }
.perm {
  border: 1px solid var(--yellow); border-radius: 12px; padding: 12px; margin: 10px 0;
  background: var(--pane);
}
.perm .title { color: var(--yellow); font-weight: 700; font-size: 13px; margin-bottom: 6px; }
.perm .desc { font-size: 13px; color: var(--muted); word-break: break-all; margin-bottom: 10px; }
.pair { max-width: 340px; margin: 18vh auto 0; padding: 0 18px; text-align: center; }
.pair input {
  width: 100%; margin: 14px 0; padding: 12px; font: inherit; text-align: center;
  background: var(--inset); color: var(--text); border: 1px solid var(--line); border-radius: 10px;
}
.card .sub.attention { color: var(--warn, #d98324); font-weight: 600; }
.section { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; margin: 16px 4px 6px; }
.empty { color: var(--faint); text-align: center; padding: 40px 0; }
.err { color: var(--red); font-size: 13px; margin-top: 8px; }
.back { color: var(--accent); background: none; border: none; font-size: 15px; padding: 4px 8px 4px 0; }
.report-body { white-space: pre-wrap; color: var(--text); font-size: 14.5px; line-height: 1.65; }
.report-summary { padding: 10px 12px; margin-bottom: 14px; border-left: 2px solid var(--accent); border-radius: 0 8px 8px 0; background: var(--inset); color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<div id="app"></div>
<script>
'use strict';
var token = localStorage.getItem('boss.token') || '';
// Relay pairing, stored once the phone scans a QR code. Empty on the
// Tailscale path, which keeps using the loopback transport.
var relay = null;
try { relay = JSON.parse(localStorage.getItem('boss.relay') || 'null'); } catch (e) { relay = null; }
var relaySocket = null;
var relayKey = null;
var relayReady = false;
var relayAttempt = 0;
var desktopOnline = true;
var pending = {};
var nextRequestId = 1;
// Set only while a QR-code claim is in flight.
var pairingClaim = null;
var pairingTimeout = null;
// Highest event sequence applied, so a reconnect can ask for the rest.
// Persisted: locking the phone can unload the page entirely.
var lastSeq = Number(localStorage.getItem('boss.seq') || '0') || 0;
// Survives the re-renders that pairing goes through, so a failure explains
// itself instead of silently returning to an empty form.
var pairError = '';
var view = { name: 'threads' };
var threads = [];
var supervision = { threads: [], totals: {} };
var threadTitles = {};
var automations = { automations: [], runs: [] };
var reports = { reports: [] };
var reportDetails = {};
var assistant = { tasks: [], taskPlans: {}, pullRequests: [], ciIncidents: [], questions: [], activities: [], mergeOrders: {} };
var messages = {};
var permissions = {};
var busy = {};
var accessRole = 'control';
var app = document.getElementById('app');
var refreshTimer = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/* ---- transport ---------------------------------------------------------
 * Two paths behind one api() call. The relay path seals every frame with a
 * key derived from the pairing secret, so the relay routes bytes it cannot
 * read. The local path is the original Tailscale/loopback transport.
 */

function b64u(bytes) {
  var binary = '';
  for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}

function unb64u(value) {
  var base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  base64 += '='.repeat((4 - (base64.length % 4)) % 4);
  var binary = atob(base64);
  var out = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function sha256(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

function deriveKey(secret) {
  return sha256('boss-relay-key:' + secret).then(function (raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  });
}

function deriveId(prefix, secret) {
  return sha256(prefix + secret).then(function (raw) {
    return b64u(new Uint8Array(raw).slice(0, 16));
  });
}

// This phone's relay identity. The private key is generated here, kept in
// localStorage beside the rest of the relay credentials, and never sent. The
// relay only ever sees the public half and signatures over its own nonces.
// Ed25519 in crypto.subtle needs Safari 17, Firefox 130 or Chrome 137.
function newIdentity() {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']).then(function (pair) {
    return Promise.all([
      crypto.subtle.exportKey('raw', pair.publicKey),
      crypto.subtle.exportKey('pkcs8', pair.privateKey)
    ]).then(function (parts) {
      return { publicKey: b64u(new Uint8Array(parts[0])), secretKey: b64u(new Uint8Array(parts[1])) };
    });
  });
}

// Signs nonce, room and side together, so a captured signature is worthless on
// another connection, in another room, or as the desktop.
function signChallenge(secretKey, nonce, roomId, side) {
  return crypto.subtle.importKey('pkcs8', unb64u(secretKey), { name: 'Ed25519' }, false, ['sign'])
    .then(function (key) {
      var message = new TextEncoder().encode('boss-relay-join ' + nonce + ' ' + roomId + ' ' + side);
      return crypto.subtle.sign({ name: 'Ed25519' }, key, message);
    })
    .then(function (signature) { return b64u(new Uint8Array(signature)); });
}

function seal(key, message) {
  var iv = crypto.getRandomValues(new Uint8Array(12));
  return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(message)))
    .then(function (cipher) { return b64u(iv) + '.' + b64u(new Uint8Array(cipher)); });
}

function unseal(key, sealed) {
  var parts = String(sealed).split('.');
  if (parts.length !== 2) return Promise.resolve(null);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(parts[0]) }, key, unb64u(parts[1]))
    .then(function (plain) { return JSON.parse(new TextDecoder().decode(plain)); })
    .catch(function () { return null; });
}

/** Remember how far we have caught up, so a reconnect resumes from here. */
function noteSeq(seq) {
  if (typeof seq !== 'number' || seq <= lastSeq) return;
  lastSeq = seq;
  try { localStorage.setItem('boss.seq', String(seq)); } catch (e) { /* private mode */ }
}

function relaySend(message) {
  if (!relaySocket || !relayKey || relaySocket.readyState !== 1) return Promise.resolve(false);
  return seal(relayKey, message).then(function (sealed) {
    relaySocket.send(JSON.stringify({ sealed: sealed }));
    return true;
  });
}

/** Requests time out rather than hang when the desktop is asleep. */
var RELAY_TIMEOUT_MS = 20000;

function relayRequest(request) {
  return new Promise(function (resolve, reject) {
    if (!relayReady) { reject(new Error(desktopOnline ? 'Connecting…' : 'Your desktop is offline.')); return; }
    var id = String(nextRequestId++);
    var timer = setTimeout(function () {
      delete pending[id];
      reject(new Error(desktopOnline ? 'The desktop did not answer.' : 'Your desktop is offline.'));
    }, RELAY_TIMEOUT_MS);
    pending[id] = { resolve: resolve, reject: reject, timer: timer };
    relaySend({ kind: 'request', id: id, request: request, token: relay.token }).then(function (sent) {
      if (sent) return;
      clearTimeout(timer);
      delete pending[id];
      reject(new Error('Not connected to the relay.'));
    });
  });
}

function api(request) {
  if (relay) return relayRequest(request);
  return fetch('/api/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(request)
  }).then(function (res) {
    if (res.status === 401) { token = ''; localStorage.removeItem('boss.token'); render(); throw new Error('unauthorized'); }
    return res.json();
  }).then(function (payload) {
    if (payload && payload.ok === false) throw new Error(payload.error || 'request failed');
    return payload ? payload.result : null;
  });
}

function refreshAccess() {
  // The relay path serves only paired control devices, so there is no
  // read-only role to look up and no /api/access endpoint to call.
  if (relay) { accessRole = 'control'; return Promise.resolve(); }
  return fetch('/api/access', { headers: { authorization: 'Bearer ' + token } })
    .then(function (res) { return res.json(); })
    .then(function (value) { accessRole = value.role || 'control'; });
}

function timeAgo(ts) {
  if (!ts) return '';
  var d = Date.now() - ts;
  if (d < 60000) return 'now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h';
  return Math.floor(d / 86400000) + 'd';
}

function refreshThreads() {
  return Promise.all([api({ type: 'thread.list' }), api({ type: 'supervision.snapshot' })]).then(function (values) {
    threads = values[0] || [];
    supervision = values[1] || { threads: [], totals: {} };
    supervision.threads.forEach(function (t) { busy[t.threadId] = Boolean(t.running); });
    if (view.name === 'threads') render();
  });
}

function refreshAutomations() {
  return api({ type: 'automation.list' }).then(function (snapshot) {
    automations = snapshot || { automations: [], runs: [] };
    if (view.name === 'automations') render();
  });
}

function refreshReports() {
  return api({ type: 'report.list' }).then(function (snapshot) {
    reports = snapshot || { reports: [] };
    if (view.name === 'reports' || view.name === 'report') render();
  });
}

function refreshAssistant() {
  return api({ type: 'assistant.snapshot' }).then(function (snapshot) {
    assistant = snapshot || { tasks: [], taskPlans: {}, pullRequests: [], ciIncidents: [], questions: [], activities: [], mergeOrders: {} };
    if (view.name === 'assistant') render();
  });
}

function refreshMessages(id) {
  return api({ type: 'thread.messages', threadId: id, limit: 60 }).then(function (list) {
    messages[id] = list || [];
    if (view.name === 'thread' && view.id === id) render();
  });
}

function textOf(message) {
  var out = [];
  (message.parts || []).forEach(function (p) { if (p.type === 'text' && p.text) out.push(p.text); });
  return out.join('\\n');
}

function stepsOf(message) {
  var tools = 0;
  (message.parts || []).forEach(function (p) { if (p.type === 'tool') tools += 1; });
  return tools;
}

// Why a thread wants the user, or '' when it does not. The phone is for
// answering these, so they sort above everything else.
function attentionReason(t) {
  var a = t.attention || {};
  if (a.kind === 'permission') return 'Needs permission';
  if (a.kind === 'question') return 'Needs an answer';
  if (a.kind === 'error') return a.detail || 'Run failed';
  if (a.kind === 'interrupted') return 'Run was interrupted';
  if (a.kind === 'completed') return a.detail || 'Finished while you were away';
  var last = t.lastRun || {};
  if (last.status === 'error') return 'Last run failed';
  return '';
}

function threadCard(t, reason) {
  var running = Boolean(t.running || busy[t.threadId]);
  var last = t.lastRun || {};
  var state = last.status === 'error' ? 'failed' : last.status === 'interrupted' ? 'interrupted' : running ? 'working' : 'idle';
  var result = t.result || {};
  var meta = esc(t.backendId || '');
  if (result.changedFiles) meta += ' · ' + result.changedFiles + ' file' + (result.changedFiles === 1 ? '' : 's');
  else if (last.toolCalls) meta += ' · ' + last.toolCalls + ' tools';
  // A worker names the thread it came from, so a nested attempt is not read as
  // unrelated work on a screen too narrow to indent.
  var origin = t.lineage && t.lineage.sourceThreadId ? threadTitles[t.lineage.sourceThreadId] : '';
  return '<button class="card" onclick="openThread(\\'' + t.threadId + '\\')">' +
    '<div class="row"><span class="dot ' + (running ? 'busy' : '') + '"></span>' +
    '<div style="flex:1;min-width:0"><div class="title">' + esc(t.title || 'Untitled') + '</div>' +
    '<div class="sub">' + meta + '</div>' +
    (origin ? '<div class="sub">from ' + esc(origin) + '</div>' : '') +
    (reason ? '<div class="sub attention">' + esc(reason) + '</div>' : '') +
    (result.summary ? '<div class="sub">' + esc(result.summary) + '</div>' : '') +
    '</div>' +
    '<span class="badge ' + esc(last.status || '') + '">' + esc(state) + '</span>' +
    '<span class="sub">' + timeAgo(t.updatedAt) + '</span></div></button>';
}

function renderThreads() {
  var all = (supervision.threads || []).slice().sort(function (a, b) {
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  threadTitles = {};
  all.forEach(function (t) { threadTitles[t.threadId] = t.title || 'Untitled'; });

  var needsMe = [];
  var rest = [];
  all.forEach(function (t) {
    var reason = attentionReason(t);
    if (reason) needsMe.push({ thread: t, reason: reason });
    else rest.push(t);
  });

  if (!all.length) return '<div class="empty">No threads yet.</div>';

  var totals = supervision.totals || {};
  var html = '';
  // What needs you comes first and says how many, because that is the question
  // the phone exists to answer.
  if (needsMe.length) {
    html += '<div class="section">' + needsMe.length + ' need' + (needsMe.length === 1 ? 's' : '') + ' you</div>';
    needsMe.forEach(function (item) { html += threadCard(item.thread, item.reason); });
  }
  html += '<div class="card"><div class="title">Task activity</div><div class="sub">' +
    (totals.runs || 0) + ' runs · ' + (totals.toolCalls || 0) + ' tools' +
    (typeof totals.tokens === 'number' ? ' · ' + totals.tokens.toLocaleString() + ' reported tokens' : '') + '</div></div>';
  if (rest.length) {
    if (needsMe.length) html += '<div class="section">Everything else</div>';
    rest.forEach(function (t) { html += threadCard(t, ''); });
  }
  return html;
}

function renderAutomations() {
  var html = '';
  if (!automations.automations.length) html = '<div class="empty">No automations yet.</div>';
  automations.automations.forEach(function (a) {
    var runs = automations.runs.filter(function (r) { return r.automationId === a.id; })
      .sort(function (x, y) { return y.startedAt - x.startedAt; });
    var last = runs[0];
    var running = runs.some(function (r) { return r.status === 'running'; });
    html += '<div class="card"><div class="row">' +
      '<div style="flex:1;min-width:0"><div class="title">' + esc(a.name) + '</div>' +
      '<div class="sub">' + (a.enabled ? (a.nextRunAt ? 'next ' + new Date(a.nextRunAt).toLocaleString() : 'manual') : 'paused') + '</div></div>' +
      (running
        ? '<button class="btn danger" onclick="stopAutomation(\\'' + a.id + '\\')">Stop</button>'
        : '<button class="btn" onclick="runAutomation(\\'' + a.id + '\\')">Run</button>') +
      '</div>';
    if (last) {
      html += '<div class="row" style="margin-top:8px;gap:8px">' +
        '<span class="badge ' + esc(last.status) + '">' + esc(last.status) + '</span>' +
        '<span class="sub" style="flex:1">' + esc(last.summary || last.error || '') + '</span>' +
        (last.threadId ? '<button class="btn" onclick="openThread(\\'' + last.threadId + '\\')">Open</button>' : '') +
        '</div>';
    }
    html += '</div>';
  });
  return html;
}

function renderReports() {
  var all = (reports.reports || []).slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  if (!all.length) return '<div class="empty">No reports yet. Ask an agent to create one, or enable reports for an automation.</div>';
  var html = '';
  all.forEach(function (report) {
    var source = report.source && report.source.kind === 'automation' ? 'Automation' : ((report.source && report.source.backendId) || 'Agent');
    html += '<button class="card" onclick="openReport(\\\'' + report.id + '\\\')">' +
      '<div class="row"><div style="flex:1;min-width:0"><div class="title">' + esc(report.title) + '</div>' +
      '<div class="sub">' + esc(report.summary || 'Saved report') + '</div>' +
      '<div class="sub">' + timeAgo(report.updatedAt) + '</div></div>' +
      '<span class="badge">' + esc(source) + '</span></div></button>';
  });
  return html;
}

function renderReport() {
  var report = reportDetails[view.id];
  if (!report) return '<div class="empty">Loading report…</div>';
  var source = report.source && report.source.kind === 'automation' ? 'Automation' : ((report.source && report.source.backendId) || 'Agent');
  return '<div class="card"><div class="row" style="margin-bottom:12px">' +
    '<span class="badge">' + esc(source) + '</span>' +
    '<span class="sub">' + esc(new Date(report.updatedAt).toLocaleString()) + '</span></div>' +
    (report.summary ? '<div class="report-summary">' + esc(report.summary) + '</div>' : '') +
    '<div class="report-body">' + esc(report.body) + '</div>' +
    (report.threadId ? '<button class="btn" style="margin-top:18px" onclick="openThread(\\\'' + report.threadId + '\\\')">Source thread</button>' : '') +
    '</div>';
}

function renderAssistant() {
  var open = (assistant.questions || []).filter(function (question) { return question.status === 'open'; });
  var incidents = (assistant.ciIncidents || []).slice().sort(function (a, b) {
    if (a.status !== b.status) return a.status === 'failing' ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  var activeIncidents = incidents.filter(function (incident) { return incident.status === 'failing'; });
  var tasks = (assistant.tasks || []).slice().sort(function (a, b) {
    var rank = { running: 0, review: 1, ready: 2, blocked: 3, inbox: 4, done: 5 };
    return (rank[a.status] || 0) - (rank[b.status] || 0) || (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  var html = '<div class="card"><div class="title">Lab Assistant</div><div class="sub">' +
    tasks.filter(function (task) { return task.status !== 'done'; }).length + ' active tasks · ' +
    activeIncidents.length + ' CI failure' + (activeIncidents.length === 1 ? '' : 's') + ' · ' +
    open.length + ' decision' + (open.length === 1 ? '' : 's') + ' waiting</div></div>';
  open.forEach(function (question) {
    html += '<div class="card"><div class="title">' + esc(question.prompt) + '</div>' +
      '<div class="sub" style="margin-top:3px">' + esc(question.repository) + '</div>';
    if (accessRole === 'control' && question.options && question.options.length) {
      html += '<div class="row" style="margin-top:10px;flex-wrap:wrap">';
      question.options.forEach(function (option) {
        html += '<button class="btn" onclick="answerAssistant(\\\'' + question.id + '\\\',\\\'' + option.id + '\\\')">' + esc(option.label) + '</button>';
      });
      html += '</div>';
    }
    html += '</div>';
  });
  if (!open.length) html += '<div class="empty">Nothing needs a decision.</div>';
  html += '<div class="section">CI monitoring</div>';
  incidents.slice(0, 6).forEach(function (incident) {
    var pr = (assistant.pullRequests || []).find(function (candidate) { return candidate.id === incident.pullRequestId; });
    var failures = [];
    (incident.jobs || []).forEach(function (job) {
      if (job.failedSteps && job.failedSteps.length) job.failedSteps.forEach(function (step) { failures.push(job.name + ' · ' + step); });
      else failures.push(job.name);
    });
    html += '<div class="card"><div class="row"><span class="badge ' + (incident.status === 'failing' ? 'failure' : 'success') + '">' + esc(incident.status) + '</span>' +
      '<div><div class="title">' + esc(incident.workflow) + '</div><div class="sub">' + esc(incident.repository) + ' · ' +
      esc(pr ? 'PR #' + pr.number : incident.headBranch) + ' · run #' + esc(incident.runNumber) + ', attempt ' + esc(incident.runAttempt) +
      (incident.occurrenceCount > 1 ? ' · ' + esc(incident.occurrenceCount) + ' consecutive failures' : '') + '</div></div></div>' +
      '<div class="sub" style="margin-top:8px">' + esc(failures.length ? failures.join(' · ') : 'Run failed before GitHub reported a failed job or step.') + '</div>' +
      '<a class="btn" style="display:inline-block;margin-top:8px;text-decoration:none" target="_blank" rel="noreferrer" href="' + esc(incident.url) + '">Open run</a></div>';
  });
  if (!incidents.length) html += '<div class="empty">No workflow failures observed.</div>';
  html += '<div class="section">Task queue</div>';
  if (accessRole === 'control') {
    var projects = {};
    (supervision.threads || []).forEach(function (thread) { if (thread.projectPath) projects[thread.projectPath] = true; });
    html += '<div class="card"><input id="assistant-task-title" aria-label="New Lab Assistant task" placeholder="Add a task…" style="width:100%;box-sizing:border-box">' +
      '<select id="assistant-task-project" aria-label="Task project" style="width:100%;margin-top:8px"><option value="">Global</option>';
    Object.keys(projects).sort().forEach(function (path) {
      html += '<option value="' + esc(path) + '">' + esc(path.split(/[\\/]/).pop() || path) + '</option>';
    });
    html += '</select><select id="assistant-task-dependency" aria-label="Task dependency" style="width:100%;margin-top:8px"><option value="">No dependency</option>';
    tasks.filter(function (task) { return task.status !== 'done'; }).forEach(function (task) {
      html += '<option value="' + esc(task.id) + '">After ' + esc(task.title) + '</option>';
    });
    html += '</select><button class="btn" style="width:100%;margin-top:8px" onclick="createAssistantTask()">Add task</button></div>';
  }
  tasks.slice(0, 12).forEach(function (task) {
    var dependencies = (task.dependsOn || []).map(function (id) {
      var found = tasks.find(function (candidate) { return candidate.id === id; });
      return found && found.title;
    }).filter(Boolean).join(', ');
    var thread = (supervision.threads || []).find(function (candidate) { return candidate.threadId === task.assignedThreadId; });
    html += '<div class="card"><div class="row"><span class="badge ' + esc(task.status) + '">' + esc(task.status) + '</span>' +
      '<div style="flex:1;min-width:0"><div class="title">' + esc(task.title) + '</div><div class="sub">' +
      esc(task.projectPath ? task.projectPath.split(/[\\/]/).pop() : 'Global') +
      (dependencies ? ' · after ' + esc(dependencies) : '') + (thread ? ' · ' + esc(thread.title) : '') + '</div></div></div>';
    if (accessRole === 'control') {
      if (task.status === 'ready') {
        if (assistant.workflowConfig && task.projectPath) {
          html += '<button class="btn primary" style="width:100%;margin-top:8px" onclick="startAssistantWorkflow(\\\'' + task.id + '\\\')">Start workflow</button>';
        }
        html += '<select aria-label="Assign ' + esc(task.title) + '" style="width:100%;margin-top:8px" onchange="assignAssistantTask(\\\'' + task.id + '\\\',this.value)">' +
          '<option value="">Assign agent…</option>';
        (supervision.threads || []).filter(function (candidate) {
          return !task.projectPath || candidate.projectPath === task.projectPath;
        }).forEach(function (candidate) {
          html += '<option value="' + esc(candidate.threadId) + '">' + esc(candidate.title) + '</option>';
        });
        html += '</select>';
      }
      if (task.status === 'running') html += '<button class="btn" style="width:100%;margin-top:8px" onclick="updateAssistantTask(\\\'' + task.id + '\\\',\\\'review\\\')">Ready for review</button>';
      else if (task.status !== 'done') html += '<button class="btn" style="width:100%;margin-top:8px" onclick="updateAssistantTask(\\\'' + task.id + '\\\',\\\'done\\\')">Mark done</button>';
    }
    html += '</div>';
  });
  if (!tasks.length) html += '<div class="empty">No tasks yet.</div>';
  if (assistant.activities && assistant.activities.length) {
    html += '<div class="section">Recent activity</div>';
    assistant.activities.slice(0, 8).forEach(function (activity) {
      html += '<div class="card"><div class="title">' + esc(activity.title) + '</div>' +
        '<div class="sub">' + esc(activity.detail) + '</div></div>';
    });
  }
  return html;
}

function renderThread() {
  var t = null;
  threads.forEach(function (x) { if (x.id === view.id) t = x; });
  var list = messages[view.id] || [];
  var html = '';
  list.forEach(function (m) {
    var text = textOf(m);
    var steps = stepsOf(m);
    var role = (m.info && m.info.role) === 'user' ? 'user' : 'assistant';
    if (!text && !steps) return;
    html += '<div class="msg ' + role + '">' +
      '<div class="who">' + (role === 'user' ? 'You' : 'Agent') + '</div>' +
      (steps ? '<div class="steps">' + steps + ' step' + (steps === 1 ? '' : 's') + '</div>' : '') +
      (text ? '<div class="body">' + esc(text) + '</div>' : '') +
      '</div>';
  });
  if (!list.length) html = '<div class="empty">Loading…</div>';
  var perm = permissions[view.id];
  if (perm) {
    var desc = (perm.metadata && perm.metadata.command) || (perm.patterns || []).join(', ') || perm.permission || '';
    html += '<div class="perm"><div class="title">Permission requested</div>' +
      '<div class="desc">' + esc(desc) + '</div>' +
      '<div class="row"><button class="btn primary" onclick="respondPermission(\\'once\\')">Allow once</button>' +
      '<button class="btn" onclick="respondPermission(\\'always\\')">Always</button>' +
      '<button class="btn danger" onclick="respondPermission(\\'reject\\')">Deny</button></div></div>';
  }
  if (busy[view.id]) html += '<div class="steps" style="color:var(--green)">Working…</div>';
  return html;
}

function render() {
  if (!token && !relay) {
    app.innerHTML = '<div class="pair"><h1>BOSS</h1>' +
      '<p style="color:var(--muted);margin-top:8px">Scan the QR code in Settings → Remote access, or paste a pairing code, to use BOSS from anywhere.</p>' +
      '<input id="code" type="text" placeholder="boss://pair?…" autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '<button class="btn primary" style="width:100%" onclick="pairWithCode(document.getElementById(\\'code\\').value)">Pair</button>' +
      '<p style="color:var(--faint);margin-top:22px;font-size:13px">On the same network or a tailnet? Paste the access token from Settings → Mobile access instead.</p>' +
      '<input id="tok" type="password" placeholder="access token" autocomplete="off">' +
      '<button class="btn" style="width:100%" onclick="pair()">Connect on this network</button>' +
      '<div class="err" id="pair-err">' + esc(pairError) + '</div>' +
      // Pairing failures were repeatedly diagnosed by guesswork. This says
      // what the phone actually has, so a failure can be read off the screen.
      '<div class="sub" style="margin-top:18px;font-size:11px;text-align:left">' +
      'code in URL: ' + (/[#?&]p=/.test(location.href) ? 'yes' : 'no') +
      '<br>saved pairing: ' + (relay ? (relay.token ? 'complete' : 'incomplete') : 'none') +
      '<br>relay: ' + esc(relay ? relay.relayUrl : '—') +
      '<br>socket: ' + (relaySocket ? ['connecting','open','closing','closed'][relaySocket.readyState] : 'none') +
      '<br>desktop: ' + (desktopOnline ? 'online' : 'offline') +
      '<button class="btn" style="width:100%;margin-top:12px" onclick="unpairRelay()">Reset pairing</button>' +
      '</div></div>';
    return;
  }
  // Paired to the relay but the desktop is asleep or offline.
  if (relay && !relay.token) {
    app.innerHTML = '<div class="pair"><h1>BOSS</h1>' +
      '<p style="color:var(--muted);margin-top:8px">Pairing…</p>' +
      '<div class="err" id="pair-err">' + esc(pairError) + '</div>' +
      // A stuck pairing sits on this screen, so the state has to be readable
      // here rather than on the form the user has already left.
      '<div class="sub" style="margin-top:18px;font-size:11px;text-align:left">' +
      'relay: ' + esc(relay.relayUrl) +
      '<br>socket: ' + (relaySocket ? ['connecting','open','closing','closed'][relaySocket.readyState] : 'none') +
      '<br>hello sent: ' + (relayReady ? 'yes' : 'no') +
      '<br>desktop: ' + (desktopOnline ? 'online' : 'offline') +
      '<br>claim pending: ' + (pairingClaim ? 'yes' : 'no') + '</div>' +
      '<button class="btn" style="width:100%;margin-top:16px" onclick="unpairRelay()">Cancel</button></div>';
    return;
  }
  var body = '';
  var title = view.name === 'assistant' ? 'Lab Assistant' : view.name === 'reports' ? 'Reports' : 'BOSS';
  var headerExtra = '';
  if (view.name === 'report') {
    var selectedReport = null;
    (reports.reports || []).forEach(function (item) { if (item.id === view.id) selectedReport = item; });
    title = (selectedReport && selectedReport.title) || 'Report';
    app.innerHTML = '<header><button class="back" onclick="goBack()">‹ Back</button><h1>' + esc(title) + '</h1></header><main>' + renderReport() + '</main>';
    return;
  }
  if (view.name === 'thread') {
    var t = null;
    threads.forEach(function (x) { if (x.id === view.id) t = x; });
    title = (t && t.title) || 'Thread';
    headerExtra = accessRole === 'control' && busy[view.id] ? '<button onclick="stopThread()">Stop</button>' : '';
    body = '<main>' + renderThread() + '</main>' +
      (accessRole === 'control' ? '<div class="composer"><textarea id="reply" rows="1" placeholder="Reply…"></textarea>' +
      '<button class="btn primary" onclick="sendReply()">Send</button></div>' : '');
    app.innerHTML = '<header><button class="back" onclick="goBack()">‹ Back</button><h1>' + esc(title) + '</h1>' + headerExtra + '</header>' + body;
    var main = app.querySelector('main');
    if (main) window.scrollTo(0, document.body.scrollHeight);
    return;
  }
  // On the relay path, say plainly when the desktop cannot be reached.
  var offline = relay && (!desktopOnline || !relayReady)
    ? '<div class="card" style="border-color:var(--yellow)"><div class="title" style="color:var(--yellow)">' +
      (desktopOnline ? 'Reconnecting…' : 'Your desktop is offline') + '</div>' +
      '<div class="sub">' + (desktopOnline ? 'Waiting for the relay.' : 'Open BOSS on your desktop to continue.') + '</div></div>'
    : '';
  body = '<main>' + offline + (view.name === 'automations' ? renderAutomations() : view.name === 'reports' ? renderReports() : view.name === 'assistant' ? renderAssistant() : renderThreads()) + '</main>' +
    '<nav class="tabs">' +
    '<button class="' + (view.name === 'threads' ? 'active' : '') + '" onclick="showTab(\\'threads\\')">Threads</button>' +
    '<button class="' + (view.name === 'automations' ? 'active' : '') + '" onclick="showTab(\\'automations\\')">Automations</button>' +
    '<button class="' + (view.name === 'reports' ? 'active' : '') + '" onclick="showTab(\\'reports\\')">Reports</button>' +
    '<button class="' + (view.name === 'assistant' ? 'active' : '') + '" onclick="showTab(\\'assistant\\')">Assistant</button>' +
    '</nav>';
  app.innerHTML = '<header><h1>' + esc(title) + '</h1></header>' + body;
}

window.pair = function () {
  var input = document.getElementById('tok');
  token = (input && input.value || '').trim();
  api({ type: 'thread.list' }).then(function () {
    localStorage.setItem('boss.token', token);
    boot();
  }).catch(function (e) {
    token = '';
    var err = document.getElementById('pair-err');
    if (err) err.textContent = e.message === 'unauthorized' ? 'That token was not accepted.' : e.message;
  });
};

window.showTab = function (name) { view = { name: name }; render(); if (name === 'automations') refreshAutomations(); else if (name === 'reports') refreshReports(); else if (name === 'assistant') refreshAssistant(); else refreshThreads(); };
window.openThread = function (id) { view = { name: 'thread', id: id }; render(); refreshMessages(id); };
window.openReport = function (id) {
  view = { name: 'report', id: id };
  render();
  api({ type: 'report.get', reportId: id }).then(function (report) {
    reportDetails[id] = report;
    if (view.name === 'report' && view.id === id) render();
  }).catch(function () { if (view.name === 'report' && view.id === id) render(); });
};
window.goBack = function () { var target = view.name === 'report' ? 'reports' : 'threads'; view = { name: target }; render(); if (target === 'reports') refreshReports(); else refreshThreads(); };
window.stopThread = function () { api({ type: 'thread.abort', threadId: view.id }).catch(function () {}); };
window.runAutomation = function (id) { api({ type: 'automation.run', automationId: id }).then(refreshAutomations).catch(function (e) { alert(e.message); }); };
window.stopAutomation = function (id) { api({ type: 'automation.stop', automationId: id }).then(refreshAutomations).catch(function (e) { alert(e.message); }); };
window.answerAssistant = function (questionId, answerId) {
  api({ type: 'assistant.answer', questionId: questionId, answerId: answerId })
    .then(function (snapshot) { assistant = snapshot || assistant; render(); })
    .catch(function (e) { alert(e.message); });
};
window.createAssistantTask = function () {
  var title = document.getElementById('assistant-task-title');
  var project = document.getElementById('assistant-task-project');
  var dependency = document.getElementById('assistant-task-dependency');
  var input = { title: (title && title.value || '').trim() };
  if (!input.title) return;
  if (project && project.value) input.projectPath = project.value;
  if (dependency && dependency.value) input.dependsOn = [dependency.value];
  api({ type: 'assistant.task.create', input: input })
    .then(function (snapshot) { assistant = snapshot || assistant; render(); })
    .catch(function (e) { alert(e.message); });
};
window.updateAssistantTask = function (taskId, status) {
  api({ type: 'assistant.task.update', taskId: taskId, patch: { status: status } })
    .then(function (snapshot) { assistant = snapshot || assistant; render(); })
    .catch(function (e) { alert(e.message); });
};
window.assignAssistantTask = function (taskId, threadId) {
  if (!threadId) return;
  api({ type: 'assistant.task.assign', taskId: taskId, threadId: threadId })
    .then(function (snapshot) { assistant = snapshot || assistant; render(); })
    .catch(function (e) { alert(e.message); });
};
window.startAssistantWorkflow = function (taskId) {
  api({ type: 'assistant.workflow.start', taskId: taskId })
    .then(function (snapshot) { assistant = snapshot || assistant; render(); })
    .catch(function (e) { alert(e.message); });
};
window.sendReply = function () {
  var input = document.getElementById('reply');
  var text = (input && input.value || '').trim();
  if (!text) return;
  input.value = '';
  api({ type: 'thread.send', threadId: view.id, parts: [{ type: 'text', text: text }] })
    .then(function () { refreshMessages(view.id); })
    .catch(function (e) { alert(e.message); });
};
window.respondPermission = function (response) {
  var perm = permissions[view.id];
  if (!perm) return;
  api({ type: 'thread.permission', threadId: view.id, permissionId: perm.id, response: response })
    .then(function () { delete permissions[view.id]; render(); })
    .catch(function (e) { alert(e.message); });
};

function scheduleRefresh(id) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(function () {
    if (view.name === 'thread' && view.id === id) refreshMessages(id);
  }, 400);
}

/**
 * Answer the relay's challenge.
 *
 * The room belongs to the DESKTOP, so its id comes from the QR code as "d" —
 * this phone cannot compute it, and that is the point. The signature is this
 * phone's own, and proves only which phone is asking; the desktop decides
 * whether to let it in when it sees the claim.
 */
function relayGreet(socket, nonce) {
  if (!relay || relaySocket !== socket) return;
  Promise.all([
    deriveKey(relay.secret),
    signChallenge(relay.secretKey, nonce, relay.deviceId, 'phone')
  ]).then(function (parts) {
    if (relaySocket !== socket || socket.readyState !== 1) return;
    relayKey = parts[0];
    socket.send(JSON.stringify({
      type: 'hello', side: 'phone', deviceId: relay.deviceId, peerId: relay.peerId,
      publicKey: relay.publicKey, signature: parts[1], v: 1
    }));
  }).catch(function (e) {
    // Without this the socket opens, signing throws, and nothing is ever sent
    // — a silent hang that looks identical to a network fault.
    pairError = 'Encryption is unavailable: ' + (e && e.message ? e.message : String(e));
    relayReady = false;
    render();
  });
}

/**
 * Open the relay socket and keep it open. Backoff matches the desktop's, so
 * a relay restart does not stampede reconnects from every paired phone.
 */
function relayConnect() {
  if (!relay || (relaySocket && relaySocket.readyState <= 1)) return;
  var url = relay.relayUrl.replace(/^http/, 'ws');
  var socket;
  try { socket = new WebSocket(url); } catch (e) { scheduleRelayReconnect(); return; }
  relaySocket = socket;

  // Nothing is sent on open: the relay speaks first with a nonce, and
  // relayGreet answers it from onmessage below.
  socket.onopen = function () { relayAttempt = 0; };

  socket.onmessage = function (raw) {
    var frame;
    try { frame = JSON.parse(raw.data); } catch (e) { return; }
    if (frame.type === 'challenge' && frame.nonce) { relayGreet(socket, frame.nonce); return; }
    if (frame.type === 'peer.online' || frame.type === 'peer.offline' || frame.type === 'welcome') {
      desktopOnline = frame.desktopOnline !== false;
      // A welcome means the relay accepted the signature. Claiming or resuming
      // any earlier would send into a socket that is about to be closed.
      if (frame.type === 'welcome') {
        relayReady = true;
        if (pairingClaim) relaySend({ kind: 'claim', secret: pairingClaim, label: navigator.platform || 'Phone' });
        else if (relay && relay.token) relaySend({ kind: 'resume', since: lastSeq, token: relay.token });
      }
      render();
      if (desktopOnline && frame.type !== 'peer.offline') boot();
      return;
    }
    if (frame.type === 'error') {
      // The relay refusing us is the likeliest pairing failure, and saying so
      // beats returning to a blank form with no explanation.
      pairError = 'Relay: ' + (frame.message || 'connection refused');
      render();
      return;
    }
    if (!frame.sealed || !relayKey) return;
    unseal(relayKey, frame.sealed).then(function (message) {
      // A frame we cannot decrypt is not from our desktop. Ignore it.
      if (!message) return;
      handleRelayMessage(message);
    });
  };

  socket.onclose = function () {
    relayReady = false;
    relaySocket = null;
    scheduleRelayReconnect();
    render();
  };

  socket.onerror = function () {
    // The browser knows why the socket failed and this is the only place it
    // says so. Discarding it meant a socket stuck at "connecting" gave no
    // reason at all, on either side.
    if (relay && !relay.token) {
      pairError = 'Could not open a connection to ' + relay.relayUrl + '. ' +
        'A phone browser refuses ws:// from some contexts, and cannot reach a host it has no route to.';
      render();
    }
  };
}

function scheduleRelayReconnect() {
  if (!relay) return;
  var delay = Math.min(30000, 500 * Math.pow(2, Math.min(relayAttempt++, 6)));
  setTimeout(relayConnect, Math.round(delay * (0.5 + Math.random() * 0.5)));
}

function handleRelayMessage(message) {
  if (message.kind === 'response') {
    var waiter = pending[message.id];
    if (!waiter) return;
    clearTimeout(waiter.timer);
    delete pending[message.id];
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error || 'request failed'));
    return;
  }
  if (message.kind === 'claimed') {
    // Pairing accepted: keep the long-lived credentials and drop the
    // one-time pairing secret.
    if (pairingTimeout) { clearTimeout(pairingTimeout); pairingTimeout = null; }
    pairingClaim = null;
    // Paired: now the secret in the URL is spent, so drop it. Doing this any
    // earlier removes the only means of retrying a failed pair.
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    // Now holding the room secret, the phone derives its own routing values
    // again — the same ones the desktop uses — so the code's copies are dropped.
    // Everything but the secret and token survives: the room id and this
    // phone's keypair are what get it back into the room on the next connect.
    relay = {
      relayUrl: relay.relayUrl,
      secret: message.secret,
      token: message.token,
      deviceId: relay.deviceId,
      publicKey: relay.publicKey,
      secretKey: relay.secretKey,
      peerId: relay.peerId
    };
    localStorage.setItem('boss.relay', JSON.stringify(relay));
    // The room key changes with the secret, so reconnect into the real room.
    relayKey = null;
    relayReady = false;
    if (relaySocket) relaySocket.close();
    relayConnect();
    boot();
    return;
  }
  if (message.kind === 'resumed') {
    // A gap means the desktop no longer had everything we missed. Refetch
    // rather than replay a partial stream, and say so on screen.
    if (message.gap) {
      noteSeq(message.seq);
      refreshThreads();
      refreshAutomations();
      refreshReports();
      refreshAssistant();
      if (view.name === 'thread') refreshMessages(view.id);
    } else {
      message.events.forEach(function (entry) { noteSeq(entry.seq); applyEvent(entry.event); });
    }
    return;
  }
  if (message.kind === 'event') { noteSeq(message.seq); applyEvent(message.event); }
}

function listen() {
  if (relay) { relayConnect(); return; }
  var source = new EventSource('/api/events?token=' + encodeURIComponent(token));
  source.onmessage = function (raw) {
    var event;
    try { event = JSON.parse(raw.data); } catch (e) { return; }
    applyEvent(event);
  };
  source.onerror = function () { /* EventSource retries on its own. */ };
}

/** One event handler for both transports. */
function applyEvent(event) {
  var props = event.properties || {};
  var sid = props.sessionID || (props.part && props.part.sessionID) || (props.info && (props.info.sessionID || props.info.id));
  if (event.type === 'session.status') busy[sid] = Boolean(props.status && (props.status.type === 'busy' || props.status.type === 'retry'));
  if (event.type === 'session.idle' || event.type === 'session.error') busy[sid] = false;
  if (event.type === 'permission.asked' || event.type === 'permission.updated') { if (props.sessionID) permissions[props.sessionID] = props; }
  if (event.type === 'permission.replied') { if (props.sessionID) delete permissions[props.sessionID]; }
  if (event.type === 'automations.updated') { automations = props.snapshot || automations; if (view.name === 'automations') render(); return; }
  if (event.type === 'reports.updated') { reports = props.snapshot || reports; if (view.name === 'reports' || view.name === 'report') render(); return; }
  if (event.type === 'assistant.updated') { assistant = props.snapshot || assistant; if (view.name === 'assistant') render(); return; }
  if (event.type.indexOf('session.') === 0) refreshThreads();
  if (view.name === 'thread' && sid === view.id) {
    if (event.type.indexOf('message.') === 0) scheduleRefresh(view.id);
    else render();
  }
}

/**
 * Finish pairing from a QR code. The phone seals a claim with the key derived
 * from the one-time secret; only the desktop can open it, and it answers with
 * long-lived credentials.
 */
window.pairWithCode = function (raw) {
  // Safari exposes crypto.subtle only in a secure context, and unlike other
  // browsers it does not exempt localhost or a LAN address. Over plain http
  // every derivation throws, so say so here rather than opening a socket that
  // can never send anything.
  if (!window.crypto || !window.crypto.subtle) {
    pairError = 'This page must be served over HTTPS. iOS hides the encryption API on plain http, ' +
      'even on a local address, so pairing cannot work here. Deploy the relay with TLS and open it over https.';
    render();
    return;
  }
  var payload = null;
  var match = /[#?&]p=([A-Za-z0-9_-]+)/.exec(String(raw).trim());
  if (match) {
    try { payload = JSON.parse(new TextDecoder().decode(unb64u(match[1]))); } catch (e) { payload = null; }
  }
  var err = document.getElementById('pair-err');
  if (!payload || payload.v !== 1 || !payload.r || !payload.s) {
    pairError = 'That is not a valid BOSS pairing code.';
    if (err) err.textContent = pairError;
    return;
  }
  // Pair using the one-time secret, then swap it for the long-lived one. The
  // room id comes from the code as "d" because it is the hash of the DESKTOP's
  // public key, which this phone has no way to compute.
  pairError = '';
  if (err) err.textContent = 'Pairing…';
  newIdentity().then(function (identity) {
    relay = {
      relayUrl: payload.r,
      secret: payload.s,
      token: '',
      deviceId: payload.d,
      // One keypair per browser, kept for the life of the pairing so the
      // desktop can revoke this phone alone.
      publicKey: identity.publicKey,
      secretKey: identity.secretKey,
      peerId: b64u(crypto.getRandomValues(new Uint8Array(8)))
    };
    // relayConnect answers the relay's challenge, then sends the claim once
    // the welcome lands; handleRelayMessage boots the app when the desktop answers.
    pairingClaim = payload.s;
    relayConnect();
    render();
  }).catch(function (e) {
    pairError = 'This browser cannot sign in to the relay: ' + (e && e.message ? e.message : String(e));
    render();
  });
  pairingTimeout = setTimeout(function () {
    if (relay && !relay.token) {
      unpairRelay();
      var late = document.getElementById('pair-err');
      pairError = 'The desktop did not answer. Check that BOSS is open, remote access is on, and the code is fresh.';
      render();
    }
  }, 20000);
};

window.unpairRelay = function () {
  relay = null;
  localStorage.removeItem('boss.relay');
  if (relaySocket) relaySocket.close();
  relaySocket = null;
  relayReady = false;
  render();
};

function boot() {
  render();
  refreshAccess().then(function () { refreshThreads(); refreshAutomations(); refreshReports(); refreshAssistant(); render(); });
  listen();
}

/**
 * Coming back from a locked screen is the common case, and it does not always
 * close the socket — iOS often freezes it instead, so no 'close' fires and the
 * connection is silently dead. On becoming visible, reconnect if the socket
 * went away, and otherwise resume, which is cheap when nothing was missed.
 */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible' || !relay || !relay.token) return;
  if (!relaySocket || relaySocket.readyState > 1) relayConnect();
  else if (relayReady) relaySend({ kind: 'resume', since: lastSeq, token: relay.token });
});

// An installed PWA needs the service worker for offline shell and push.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(function () {
    /* Pairing and chat work without it; only offline and push are lost. */
  });
}

/**
 * Scanning the QR code lands here with the payload in the fragment. Pair
 * immediately, then strip it from the URL so a screenshot or a back-button
 * revisit cannot replay a spent secret.
 */
// A scanned code always wins. Requiring !relay here meant that once a failed
// attempt had stored half-paired credentials, every later scan was ignored and
// the phone kept retrying with a secret the desktop had already forgotten.
if (/[#?&]p=[A-Za-z0-9_-]+/.test(location.href) && (!relay || !relay.token)) {
  // Keep the fragment until pairing succeeds. Stripping it up front destroyed
  // the only copy of the secret, so a failure left no way to retry and no way
  // to see what went wrong. handleRelayMessage clears it on 'claimed'.
  //
  // pairWithCode renders once it has set state; rendering here first would
  // only show the state from BEFORE the attempt, which reads as "nothing
  // happened" even when pairing is under way.
  window.pairWithCode(location.href);
} else if (relay) { relayConnect(); render(); }
else if (token) boot();
else render();
</script>
</body>
</html>
`
