/**
 * The mobile site, served as one self-contained document — no build step,
 * no external assets, works offline-cached once loaded. It speaks the same
 * BackendRequest protocol as the desktop renderer through POST /api/request
 * and listens on /api/events (SSE). Scope: review and steer — threads,
 * replies, stop, permissions, automations. Never configuration.
 */
export const MOBILE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0d10">
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
.empty { color: var(--faint); text-align: center; padding: 40px 0; }
.err { color: var(--red); font-size: 13px; margin-top: 8px; }
.back { color: var(--accent); background: none; border: none; font-size: 15px; padding: 4px 8px 4px 0; }
</style>
</head>
<body>
<div id="app"></div>
<script>
'use strict';
var token = localStorage.getItem('boss.token') || '';
var view = { name: 'threads' };
var threads = [];
var automations = { automations: [], runs: [] };
var messages = {};
var permissions = {};
var busy = {};
var app = document.getElementById('app');
var refreshTimer = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function api(request) {
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

function timeAgo(ts) {
  if (!ts) return '';
  var d = Date.now() - ts;
  if (d < 60000) return 'now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h';
  return Math.floor(d / 86400000) + 'd';
}

function refreshThreads() {
  return api({ type: 'thread.list' }).then(function (list) {
    threads = list || [];
    threads.forEach(function (t) { busy[t.id] = Boolean(t.busy); });
    if (view.name === 'threads') render();
  });
}

function refreshAutomations() {
  return api({ type: 'automation.list' }).then(function (snapshot) {
    automations = snapshot || { automations: [], runs: [] };
    if (view.name === 'automations') render();
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

function renderThreads() {
  var sorted = threads.slice().sort(function (a, b) {
    return ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0);
  });
  var html = '';
  if (!sorted.length) html = '<div class="empty">No threads yet.</div>';
  sorted.forEach(function (t) {
    html += '<button class="card" onclick="openThread(\\'' + t.id + '\\')">' +
      '<div class="row"><span class="dot ' + (busy[t.id] ? 'busy' : '') + '"></span>' +
      '<div style="flex:1;min-width:0"><div class="title">' + esc(t.title || 'Untitled') + '</div>' +
      '<div class="sub">' + esc(t.backendId || '') + (busy[t.id] ? ' · working' : '') + '</div></div>' +
      '<span class="sub">' + timeAgo(t.time && t.time.updated) + '</span></div></button>';
  });
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
  if (!token) {
    app.innerHTML = '<div class="pair"><h1>BOSS</h1>' +
      '<p style="color:var(--muted);margin-top:8px">Paste the access token from Settings → Mobile access on your desktop.</p>' +
      '<input id="tok" type="password" placeholder="access token" autocomplete="off">' +
      '<button class="btn primary" style="width:100%" onclick="pair()">Connect</button>' +
      '<div class="err" id="pair-err"></div></div>';
    return;
  }
  var body = '';
  var title = 'BOSS';
  var headerExtra = '';
  if (view.name === 'thread') {
    var t = null;
    threads.forEach(function (x) { if (x.id === view.id) t = x; });
    title = (t && t.title) || 'Thread';
    headerExtra = busy[view.id] ? '<button onclick="stopThread()">Stop</button>' : '';
    body = '<main>' + renderThread() + '</main>' +
      '<div class="composer"><textarea id="reply" rows="1" placeholder="Reply…"></textarea>' +
      '<button class="btn primary" onclick="sendReply()">Send</button></div>';
    app.innerHTML = '<header><button class="back" onclick="goBack()">‹ Back</button><h1>' + esc(title) + '</h1>' + headerExtra + '</header>' + body;
    var main = app.querySelector('main');
    if (main) window.scrollTo(0, document.body.scrollHeight);
    return;
  }
  body = '<main>' + (view.name === 'automations' ? renderAutomations() : renderThreads()) + '</main>' +
    '<nav class="tabs">' +
    '<button class="' + (view.name === 'threads' ? 'active' : '') + '" onclick="showTab(\\'threads\\')">Threads</button>' +
    '<button class="' + (view.name === 'automations' ? 'active' : '') + '" onclick="showTab(\\'automations\\')">Automations</button>' +
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

window.showTab = function (name) { view = { name: name }; render(); if (name === 'automations') refreshAutomations(); else refreshThreads(); };
window.openThread = function (id) { view = { name: 'thread', id: id }; render(); refreshMessages(id); };
window.goBack = function () { view = { name: 'threads' }; render(); refreshThreads(); };
window.stopThread = function () { api({ type: 'thread.abort', threadId: view.id }).catch(function () {}); };
window.runAutomation = function (id) { api({ type: 'automation.run', automationId: id }).then(refreshAutomations).catch(function (e) { alert(e.message); }); };
window.stopAutomation = function (id) { api({ type: 'automation.stop', automationId: id }).then(refreshAutomations).catch(function (e) { alert(e.message); }); };
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

function listen() {
  var source = new EventSource('/api/events?token=' + encodeURIComponent(token));
  source.onmessage = function (raw) {
    var event;
    try { event = JSON.parse(raw.data); } catch (e) { return; }
    var props = event.properties || {};
    var sid = props.sessionID || (props.part && props.part.sessionID) || (props.info && (props.info.sessionID || props.info.id));
    if (event.type === 'session.status') busy[sid] = Boolean(props.status && (props.status.type === 'busy' || props.status.type === 'retry'));
    if (event.type === 'session.idle' || event.type === 'session.error') busy[sid] = false;
    if (event.type === 'permission.asked' || event.type === 'permission.updated') { if (props.sessionID) permissions[props.sessionID] = props; }
    if (event.type === 'permission.replied') { if (props.sessionID) delete permissions[props.sessionID]; }
    if (event.type === 'automations.updated') { automations = props.snapshot || automations; if (view.name === 'automations') render(); return; }
    if (event.type.indexOf('session.') === 0) refreshThreads();
    if (view.name === 'thread' && sid === view.id) {
      if (event.type.indexOf('message.') === 0) scheduleRefresh(view.id);
      else render();
    }
  };
  source.onerror = function () { /* EventSource retries on its own. */ };
}

function boot() {
  render();
  refreshThreads();
  refreshAutomations();
  listen();
}

if (token) boot(); else render();
</script>
</body>
</html>
`
