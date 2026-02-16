import { sendErrorResponse } from "../utils.js";
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function getEndpointConfig(nodelink) {
    const endpoint = nodelink.options?.cluster?.endpoint || {};
    const code = typeof endpoint.code === 'string' && endpoint.code.length > 0
        ? endpoint.code
        : 'CAPYBARA';
    return {
        patchEnabled: endpoint.patchEnabled === true,
        allowExternalPatch: endpoint.allowExternalPatch === true,
        code
    };
}
function buildPage(code) {
    const safeCode = JSON.stringify(code);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NodeLink Live DevTools</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
    :root {
      --bg: #0b1118;
      --bg2: #0f1723;
      --card: #101b2a;
      --line: #23384e;
      --text: #d9e7f6;
      --muted: #88a2bc;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
      --cyan: #22d3ee;
      --blue: #38bdf8;
      --yellow: #facc15;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "Space Grotesk", sans-serif;
      background:
        radial-gradient(1200px 480px at -15% -20%, #143046 0%, transparent 55%),
        radial-gradient(900px 480px at 110% 0%, #162f3f 0%, transparent 55%),
        linear-gradient(180deg, var(--bg), #070c12);
      min-height: 100vh;
    }
    .wrap { max-width: 1380px; margin: 20px auto; padding: 0 14px 24px; }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .title { font-size: 26px; font-weight: 700; letter-spacing: .2px; }
    .title small { color: var(--muted); font-weight: 500; font-size: 14px; margin-left: 8px; }
    .ctrl { display: flex; gap: 8px; align-items: center; }
    .pill {
      border: 1px solid var(--line);
      background: #0f1a27;
      color: var(--muted);
      border-radius: 999px;
      padding: 7px 11px;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
    }
    .pill.live { color: var(--ok); box-shadow: 0 0 0 1px #0f1a27 inset, 0 0 18px rgba(34,197,94,.2); }
    .btn {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, #17314a, #12263a);
      color: var(--text);
      border-radius: 10px;
      padding: 7px 11px;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      cursor: pointer;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-bottom: 10px;
    }
    .card {
      background: linear-gradient(180deg, #122235, var(--card));
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      animation: rise .35s ease;
    }
    @keyframes rise { from { transform: translateY(8px); opacity: .5; } to { transform: translateY(0); opacity: 1; } }
    .label { color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: .7px; }
    .big { font-family: "JetBrains Mono", monospace; font-size: 21px; margin-top: 8px; }
    .sub { color: var(--muted); font-size: 11px; margin-top: 4px; }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr);
      gap: 10px;
    }
    .col {
      display: grid;
      gap: 10px;
      min-width: 0;
      align-content: start;
    }
    .panel {
      background: #0d1724;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      overflow: hidden;
      min-width: 0;
    }
    .panel.fill {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .panel h3 {
      margin: 0 0 8px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: .7px;
      color: var(--muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .trace {
      height: 260px;
      border: 1px solid var(--line);
      border-radius: 9px;
      background:
        repeating-linear-gradient(0deg, transparent, transparent 25px, rgba(255,255,255,.03) 26px),
        linear-gradient(180deg, rgba(255,255,255,.02), rgba(0,0,0,.1)),
        #0f1825;
    }
    .trace svg { width: 100%; height: 100%; display: block; }
    .legend { margin-top: 7px; display: flex; gap: 12px; font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .dot { width: 9px; height: 9px; border-radius: 999px; display: inline-block; margin-right: 6px; }

    .table-wrap { max-height: 320px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-family: "JetBrains Mono", monospace; font-size: 11px; }
    th, td { border-bottom: 1px solid rgba(35,56,78,.6); padding: 6px 7px; text-align: left; }
    th { color: var(--muted); position: sticky; top: 0; background: #112032; z-index: 2; }

    .list {
      max-height: none;
      overflow: visible;
      display: grid;
      gap: 8px;
      min-width: 0;
      align-content: start;
      grid-auto-rows: max-content;
    }
    .list-scroll {
      max-height: 320px;
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-gutter: stable both-edges;
      min-width: 0;
    }
    .panel.fill .list {
      max-height: none;
      height: auto;
      min-height: 0;
      flex: unset;
    }
    .panel.fill .list.list-scroll {
      max-height: 320px;
      overflow: auto;
    }
    .item {
      border: 1px solid #28435e;
      border-radius: 8px;
      background: #101f30;
      padding: 9px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      line-height: 1.5;
      word-break: break-word;
      overflow-wrap: anywhere;
      min-width: 0;
      overflow: visible;
      max-width: 100%;
    }
    .item b, .item .muted, .item div { overflow-wrap: anywhere; word-break: break-word; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .stack { display: grid; gap: 5px; min-width: 0; }
    .kv {
      display: grid;
      grid-template-columns: 84px minmax(0, 1fr);
      gap: 6px;
      align-items: start;
      min-width: 0;
    }
    .k { color: var(--muted); text-transform: lowercase; }
    .v { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
    .item.warn { border-color: rgba(245,158,11,.6); background: rgba(120,53,15,.22); }
    .item.err { border-color: rgba(239,68,68,.6); background: rgba(127,29,29,.22); }
    .item.ok { border-color: rgba(34,197,94,.6); background: rgba(20,83,45,.24); }
    .track-card {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .track-head {
      display: grid;
      grid-template-columns: 54px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      min-width: 0;
    }
    .track-art {
      width: 54px;
      height: 54px;
      border-radius: 8px;
      border: 1px solid #28435e;
      object-fit: cover;
      background: #0d1724;
      display: block;
    }
    .track-meta { min-width: 0; display: grid; gap: 4px; }
    .status {
      border-radius: 999px;
      padding: 1px 8px;
      border: 1px solid #315478;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .5px;
    }
    .status-idle { border-color: #64748b; color: #94a3b8; }
    .status-working { border-color: #22c55e; color: #86efac; }
    .status-paused { border-color: #f59e0b; color: #fcd34d; }
    .status-connecting, .status-reconnecting { border-color: #38bdf8; color: #7dd3fc; }
    .status-disconnected, .status-destroyed { border-color: #ef4444; color: #fca5a5; }
    .progress {
      height: 7px;
      border-radius: 999px;
      border: 1px solid #28435e;
      background: #0f1b2a;
      overflow: hidden;
    }
    .progress > i {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, #22d3ee, #38bdf8);
    }
    .item.net {
      padding: 6px 8px;
      line-height: 1.25;
      overflow: visible;
    }
    .item.net .path-line {
      margin-top: 2px;
      font-weight: 600;
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .item.net .meta-line {
      margin-top: 2px;
      color: var(--muted);
      font-size: 10px;
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    #requests.list-scroll { height: 420px; max-height: 420px; }
    #events.list-scroll { max-height: 320px; }
    #allocSites.list-scroll { max-height: 420px; }
    .muted { color: var(--muted); }
    .tag {
      display: inline-flex;
      align-items: center;
      border: 1px solid #315478;
      border-radius: 999px;
      padding: 1px 7px;
      margin-right: 6px;
      margin-bottom: 6px;
      color: #b4d4ef;
      vertical-align: middle;
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .callsite {
      color: #67e8f9;
      text-decoration: underline;
      cursor: pointer;
    }
    .snippet {
      max-height: 260px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #09111b;
      padding: 8px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      line-height: 1.45;
      white-space: pre;
    }
    .snippet-line-hit { background: rgba(56,189,248,.18); border-radius: 4px; }

    @media (max-width: 1100px) {
      .layout { grid-template-columns: 1fr; }
      .table-wrap { overflow-x: auto; }
      table { min-width: 780px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="title">NodeLink Live DevTools <small>cluster observability + trace</small></div>
      <div class="ctrl">
        <button id="captureMem" class="btn" type="button">capture memory</button>
        <div class="pill">allocTop manual / 3s sample</div>
        <div id="conn" class="pill">connecting...</div>
      </div>
    </div>

    <div class="cards">
      <div class="card"><div class="label">Master RSS</div><div id="mRss" class="big">-</div><div class="sub">resident set</div></div>
      <div class="card"><div class="label">Workers Heap</div><div id="wHeap" class="big">-</div><div class="sub">sum heapUsed</div></div>
      <div class="card"><div class="label">Source Heap</div><div id="sHeap" class="big">-</div><div class="sub">source micro-workers</div></div>
      <div class="card"><div class="label">Warnings</div><div id="warnCount" class="big">0</div><div class="sub">anomaly detector</div></div>
      <div class="card"><div class="label">Req/s (window)</div><div id="rps" class="big">0.0</div><div class="sub">from request trace</div></div>
      <div class="card"><div class="label">Trace Buffer</div><div id="traceCount" class="big">0</div><div class="sub">network + events</div></div>
    </div>

    <div class="layout">
      <div class="col">
        <div class="panel">
          <h3>Timeline Trace</h3>
          <div class="trace"><svg id="trace" viewBox="0 0 1000 260" preserveAspectRatio="none"></svg></div>
          <div class="legend">
            <span><i class="dot" style="background:#22d3ee"></i>Master RSS</span>
            <span><i class="dot" style="background:#38bdf8"></i>Workers Heap</span>
            <span><i class="dot" style="background:#facc15"></i>Source Heap</span>
          </div>
        </div>

        <div class="panel">
          <h3>Process Explorer <span class="muted">master/workers/source with handles/resources</span></h3>
          <div class="table-wrap">
            <table id="procTable">
              <thead><tr><th>Type</th><th>PID</th><th>Heap</th><th>RSS</th><th>Ext/AB</th><th>Handles</th><th>Resources</th><th>Context</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <h3>V8 Spaces</h3>
          <div id="v8Spaces" class="list list-scroll"></div>
        </div>

        <div class="panel">
          <h3>Caches / Maps</h3>
          <div id="caches" class="list list-scroll"></div>
        </div>

        <div class="panel">
          <h3>Stream Lifecycle</h3>
          <div id="streamLife" class="list list-scroll"></div>
        </div>

        <div class="panel">
          <h3>Buffer Pool</h3>
          <div id="bufferPool" class="list list-scroll"></div>
        </div>

        <div class="panel">
          <h3>Demux / WebmOpus</h3>
          <div id="demux" class="list list-scroll"></div>
        </div>

        <div class="panel">
          <h3>Origins / Tracks (Where it comes from)</h3>
          <div id="origins" class="list list-scroll"></div>
        </div>

        <div class="panel">
          <h3>Source / Protocol Groups</h3>
          <div id="groups" class="list list-scroll"></div>
        </div>
      </div>

      <div class="col">
        <div class="panel fill">
          <h3>Warnings & Heuristics</h3>
          <div id="warns" class="list list-scroll"></div>
        </div>

        <div class="panel fill">
          <h3>Network Trace</h3>
          <div id="requests" class="list list-scroll" style="max-height:420px"></div>
        </div>

        <div class="panel fill">
          <h3>Error Console / Events</h3>
          <div id="events" class="list list-scroll"></div>
        </div>

        <div class="panel">
          <h3>Heap Artifacts (Auto)</h3>
          <div id="allReport" class="list list-scroll"></div>
        </div>

        <div class="panel">
          <h3>Allocation Sites (ALL callsites)</h3>
          <div id="allocSites" class="list list-scroll"></div>
        </div>

        <div class="panel">
          <h3>Callsite Inspector</h3>
          <div id="snippetMeta" class="muted" style="margin-bottom:6px">Click a callsite to open source snippet.</div>
          <div id="snippet" class="snippet">No snippet loaded.</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const code = ${safeCode}
    const conn = document.getElementById('conn')
    const captureMem = document.getElementById('captureMem')
    const traceSvg = document.getElementById('trace')
    const warns = document.getElementById('warns')
    const requests = document.getElementById('requests')
    const events = document.getElementById('events')
    const origins = document.getElementById('origins')
    const groups = document.getElementById('groups')
    const allReport = document.getElementById('allReport')
    const allocSites = document.getElementById('allocSites')
    const v8Spaces = document.getElementById('v8Spaces')
    const caches = document.getElementById('caches')
    const streamLife = document.getElementById('streamLife')
    const bufferPool = document.getElementById('bufferPool')
    const demux = document.getElementById('demux')
    const snippet = document.getElementById('snippet')
    const snippetMeta = document.getElementById('snippetMeta')
    const procTableBody = document.querySelector('#procTable tbody')

    const mRss = document.getElementById('mRss')
    const wHeap = document.getElementById('wHeap')
    const sHeap = document.getElementById('sHeap')
    const warnCount = document.getElementById('warnCount')
    const rps = document.getElementById('rps')
    const traceCount = document.getElementById('traceCount')

    const history = []
    const maxPoints = 180
    const reqTs = []
    let latestAllocTop = null
    let captureInFlight = false
    let pageClosing = false
    const warningState = new Map()
    const warningHistoryMax = 240
    const LOCAL_STATE_KEY = 'nodelink_profiler_ui_state_v2_' + location.host + '_' + code

    const safePct = (v) => Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-'

    const mb = (v) => {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) return '-'
      return (n / 1024 / 1024).toFixed(1)
    }

    const fmtMs = (value) => {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) return '-'
      const totalSec = Math.floor(n / 1000)
      const h = Math.floor(totalSec / 3600)
      const m = Math.floor((totalSec % 3600) / 60)
      const s = totalSec % 60
      if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
      return m + ':' + String(s).padStart(2, '0')
    }

    function drawLine(points, color, maxY) {
      if (points.length < 2) return ''
      const w = 1000, h = 260
      const step = w / Math.max(points.length - 1, 1)
      let d = ''
      for (let i = 0; i < points.length; i++) {
        const x = i * step
        const y = h - Math.min(h, (points[i] / Math.max(maxY, 1)) * h)
        d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2)
      }
      return '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.3" stroke-linecap="round"/>'
    }

    function renderTrace() {
      const a = history.map(x => x.masterRss)
      const b = history.map(x => x.workersHeap)
      const c = history.map(x => x.sourceHeap)
      const maxY = Math.max(1, ...a, ...b, ...c)
      traceSvg.innerHTML = [
        drawLine(a, '#22d3ee', maxY),
        drawLine(b, '#38bdf8', maxY),
        drawLine(c, '#facc15', maxY)
      ].join('')
    }

    function buildChartPoint(snapshot) {
      const masterRss = Number(snapshot?.master?.memory?.rss || 0)
      let workersHeap = 0
      for (const w of (snapshot?.workers || [])) workersHeap += Number(w?.response?.memory?.heapUsed || 0)
      let sourceHeap = 0
      for (const s of (snapshot?.sourceWorkers || [])) sourceHeap += Number(s?.response?.memory?.heapUsed || 0)
      return { masterRss, workersHeap, sourceHeap }
    }

    function setCardsFromPoint(point) {
      mRss.textContent = mb(point?.masterRss || 0) + ' MB'
      wHeap.textContent = mb(point?.workersHeap || 0) + ' MB'
      sHeap.textContent = mb(point?.sourceHeap || 0) + ' MB'
    }

    function loadLocalState() {
      try {
        const raw = localStorage.getItem(LOCAL_STATE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }

    function saveLocalState(snapshot, warnings, allocTop) {
      try {
        const warningEntries = Array.from(warningState.values())
        const state = {
          chartHistory: history.slice(-maxPoints),
          lastSnapshot: snapshot || null,
          lastWarnings: warnings || [],
          warningHistory: warningEntries.slice(0, warningHistoryMax),
          lastAllocTop: allocTop || null,
          savedAt: Date.now()
        }
        localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state))
      } catch {}
    }

    function setList(el, rows, className = '', limit = 80) {
      el.innerHTML = ''
      if (!rows || rows.length === 0) {
        const div = document.createElement('div')
        div.className = 'item'
        div.textContent = 'No data yet.'
        el.appendChild(div)
        return
      }
      const entries = typeof limit === 'number' && limit > 0 ? rows.slice(0, limit) : rows
      for (const row of entries) {
        const div = document.createElement('div')
        div.className =
          'item ' +
          className +
          ' ' +
          (row.level === 'warn' ? 'warn' : '') +
          ' ' +
          (row.level === 'error' ? 'err' : '') +
          ' ' +
          (row.level === 'ok' ? 'ok' : '')
        div.innerHTML = row.html || row.text || ''
        el.appendChild(div)
      }
    }

    function fmtTime(ts) {
      if (!Number.isFinite(ts) || ts <= 0) return '-'
      const d = new Date(ts)
      return d.toLocaleTimeString()
    }

    function warningKey(w) {
      return [
        String(w?.type || 'trace'),
        String(w?.kind || '-'),
        String(w?.pid || '-'),
        String(w?.message || 'unknown')
      ].join('|')
    }

    function restoreWarningHistory(entries) {
      if (!Array.isArray(entries)) return
      warningState.clear()
      for (const entry of entries.slice(0, warningHistoryMax)) {
        if (!entry || typeof entry !== 'object') continue
        const key = String(entry.key || '')
        if (!key) continue
        warningState.set(key, {
          key,
          type: String(entry.type || 'trace'),
          kind: String(entry.kind || '-'),
          pid: String(entry.pid || '-'),
          message: String(entry.message || 'unknown'),
          severity: entry.severity === 'error' ? 'error' : 'warn',
          status: entry.status === 'resolved' ? 'resolved' : 'active',
          firstSeenAt: Number(entry.firstSeenAt || Date.now()),
          lastSeenAt: Number(entry.lastSeenAt || Date.now()),
          resolvedAt:
            entry.resolvedAt == null ? null : Number(entry.resolvedAt || Date.now())
        })
      }
    }

    function updateWarningHistory(currentWarnings) {
      const now = Date.now()
      const current = Array.isArray(currentWarnings) ? currentWarnings : []
      const seen = new Set()

      for (const w of current) {
        const key = warningKey(w)
        seen.add(key)
        const existing = warningState.get(key)
        const severity = w?.level === 'warn' ? 'warn' : 'error'

        if (!existing) {
          warningState.set(key, {
            key,
            type: String(w?.type || 'trace'),
            kind: String(w?.kind || '-'),
            pid: String(w?.pid || '-'),
            message: String(w?.message || 'unknown'),
            severity,
            status: 'active',
            firstSeenAt: now,
            lastSeenAt: now,
            resolvedAt: null
          })
          continue
        }

        existing.lastSeenAt = now
        existing.severity = severity
        if (existing.status === 'resolved') {
          existing.status = 'active'
          existing.resolvedAt = null
        }
      }

      for (const entry of warningState.values()) {
        if (entry.status === 'active' && !seen.has(entry.key)) {
          entry.status = 'resolved'
          entry.resolvedAt = now
        }
      }

      const ordered = Array.from(warningState.values()).sort((a, b) => {
        const ta = Math.max(a.lastSeenAt || 0, a.resolvedAt || 0)
        const tb = Math.max(b.lastSeenAt || 0, b.resolvedAt || 0)
        return tb - ta
      })

      warningState.clear()
      for (const entry of ordered.slice(0, warningHistoryMax)) {
        warningState.set(entry.key, entry)
      }
    }

    function flattenProcesses(snapshot) {
      const rows = []
      if (snapshot?.master) {
        rows.push({
          type: 'master',
          pid: snapshot.master.pid,
          memory: snapshot.master.memory,
          activeHandles: snapshot.master.runtime?.activeHandles || {},
          activeResources: snapshot.master.runtime?.activeResources || {},
          context: 'api + cluster orchestration'
        })
      }
      for (const w of (snapshot?.workers || [])) {
        const r = w?.response || {}
        const workerError = w?.error || r?.error || null
        rows.push({
          type: 'worker',
          pid: w.pid,
          memory: r.memory,
          activeHandles: r.activeHandles || {},
          activeResources: r.activeResources || {},
          context: workerError
            ? ('ERROR: ' + workerError)
            : (r.workersContext?.playersCount || 0) + ' players | ' + (r.workersContext?.activeStreams || 0) + ' streams',
          error: workerError
        })
      }
      for (const s of (snapshot?.sourceWorkers || [])) {
        const r = s?.response || {}
        const sourceError = s?.error || r?.error || null
        rows.push({
          type: 'sourceWorker',
          pid: s.pid,
          memory: r.memory,
          activeHandles: r.activeHandles || {},
          activeResources: r.activeResources || {},
          context: sourceError
            ? ('ERROR: ' + sourceError)
            : 'activeChats=' + (r.sourceContext?.activeChats || 0),
          error: sourceError
        })
      }
      return rows
    }

    function renderProcessTable(snapshot) {
      const rows = flattenProcesses(snapshot)
      procTableBody.innerHTML = ''
      for (const row of rows) {
        const tr = document.createElement('tr')
        const handles = Object.entries(row.activeHandles || {}).slice(0, 4).map(([k,v]) => k + ':' + v).join(', ')
        const resources = Object.entries(row.activeResources || {}).slice(0, 4).map(([k,v]) => k + ':' + v).join(', ')
        const heapUsed = mb(row.memory?.heapUsed)
        const heapTotal = mb(row.memory?.heapTotal)
        const rss = mb(row.memory?.rss)
        const external = mb(row.memory?.external)
        const arrayBuffers = mb(row.memory?.arrayBuffers)
        const hasMemory = heapUsed !== '-' && heapTotal !== '-' && rss !== '-'
        const contextClass = row.error ? 'muted' : ''
        tr.innerHTML = [
          '<td><span class="tag">'+row.type+'</span></td>',
          '<td>'+ (row.pid || '-') +'</td>',
          '<td>'+ (hasMemory ? (heapUsed + ' / ' + heapTotal + ' MB') : '-') +'</td>',
          '<td>'+ (rss !== '-' ? (rss + ' MB') : '-') +'</td>',
          '<td>'+ ((external !== '-' || arrayBuffers !== '-') ? (external + ' / ' + arrayBuffers + ' MB') : '-') +'</td>',
          '<td>'+ (row.error ? '-' : (handles || '-')) +'</td>',
          '<td>'+ (row.error ? '-' : (resources || '-')) +'</td>',
          '<td class="' + contextClass + '">'+ (row.context || '-') +'</td>'
        ].join('')
        procTableBody.appendChild(tr)
      }
    }

    function renderV8Spaces(snapshot) {
      const rows = []
      const pushSpaces = (owner, spaces) => {
        for (const s of (spaces || [])) {
          const used = Number(s.spaceUsedSize || 0)
          const size = Number(s.spaceSize || 0)
          const ratio = size > 0 ? used / size : 0
          rows.push({
            text:
              '<span class="tag">' + owner + '</span>' +
              '<span class="tag">' + (s.spaceName || '-') + '</span>' +
              '<span class="tag">' + safePct(ratio) + '</span>' +
              '<div class="muted">used ' + mb(used) + ' MB / size ' + mb(size) + ' MB</div>'
          })
        }
      }
      pushSpaces('master', snapshot?.master?.heapSpaces || snapshot?.master?.runtime?.heapSpaces)
      for (const w of (snapshot?.workers || [])) pushSpaces('worker ' + (w.pid || '-'), w?.response?.heapSpaces)
      for (const s of (snapshot?.sourceWorkers || [])) pushSpaces('source ' + (s.pid || '-'), s?.response?.heapSpaces)
      setList(v8Spaces, rows, '', 0)
    }

    function renderCaches(snapshot) {
      const rows = []
      const masterMaps = snapshot?.master?.runtime?.mapSizes || {}
      if (masterMaps && typeof masterMaps === 'object') {
        for (const [k, v] of Object.entries(masterMaps)) {
          rows.push({ text: '<span class="tag">master</span><b>' + k + '</b> <span class="muted">' + String(v) + '</span>' })
        }
      }

      for (const w of (snapshot?.workers || [])) {
        const mapSizes = w?.response?.workersContext?.mapSizes || {}
        for (const [k, v] of Object.entries(mapSizes)) {
          rows.push({
            text:
              '<span class="tag">worker ' + (w.pid || '-') + '</span><b>' + k + '</b> <span class="muted">' + String(v) + '</span>'
          })
        }
      }

      const sourceCtx = snapshot?.master?.runtime?.sourceContext || {}
      if (sourceCtx && typeof sourceCtx === 'object') {
        if (sourceCtx.pendingRequests != null) {
          rows.push({ text: '<span class="tag">source mgr</span><b>pendingRequests</b> <span class="muted">' + String(sourceCtx.pendingRequests) + '</span>' })
        }
      }

      setList(caches, rows, '', 0)
    }

    function renderStreamLifecycle(snapshot) {
      const rows = []
      for (const w of (snapshot?.workers || [])) {
        const life = w?.response?.workersContext?.streamLifecycle
        if (!life) continue
        rows.push({
          text:
            '<span class="tag">worker ' + (w.pid || '-') + '</span>' +
            '<span class="tag">created ' + (life.created || 0) + '</span>' +
            '<span class="tag">ended ' + (life.ended || 0) + '</span>' +
            '<span class="tag">errored ' + (life.errored || 0) + '</span>' +
            '<span class="tag">cancelled ' + (life.cancelled || 0) + '</span>' +
            '<span class="tag">cleaned ' + (life.cleaned || 0) + '</span>'
        })
      }
      setList(streamLife, rows, '', 0)
    }

    function renderBufferPool(snapshot) {
      const rows = []
      for (const w of (snapshot?.workers || [])) {
        const bp = w?.response?.workersContext?.bufferPool
        if (!bp) continue
        rows.push({
          text:
            '<span class="tag">worker ' + (w.pid || '-') + '</span>' +
            '<span class="tag">total ' + mb(bp.totalBytes) + 'MB</span>' +
            '<span class="tag">high ' + mb(bp.highWaterBytes) + 'MB</span>' +
            '<span class="tag">buckets ' + (bp.buckets || 0) + '</span>' +
            '<span class="tag">reuse ' + safePct(bp.reuseRatio || 0) + '</span>'
        })
        for (const bucket of (bp.topBuckets || []).slice(0, 10)) {
          rows.push({
            text:
              '<span class="tag">bucket</span>' +
              '<span class="tag">' + (bucket.size || 0) + ' bytes</span>' +
              '<span class="tag">count ' + (bucket.count || 0) + '</span>' +
              '<span class="muted">bytes ' + mb(bucket.bytes || 0) + ' MB</span>'
          })
        }
      }
      setList(bufferPool, rows, '', 0)
    }

    function renderDemux(snapshot) {
      const rows = []
      for (const w of (snapshot?.workers || [])) {
        const d = w?.response?.workersContext?.demuxers?.webmOpus
        if (!d) continue
        rows.push({
          text:
            '<span class="tag">worker ' + (w.pid || '-') + '</span>' +
            '<span class="tag">active ' + (d.active || 0) + '</span>' +
            '<span class="tag">chunksIn ' + (d.chunksIn || 0) + '</span>' +
            '<span class="tag">bytesIn ' + mb(d.bytesIn || 0) + 'MB</span>' +
            '<span class="tag">packetsOut ' + (d.packetsOut || 0) + '</span>' +
            '<span class="tag">out ' + mb(d.packetBytesOut || 0) + 'MB</span>' +
            '<span class="tag">ringPeak ' + mb(d.ringPeakBytes || 0) + 'MB</span>'
        })
      }
      setList(demux, rows, '', 0)
    }

    function renderOrigins(snapshot) {
      const rows = []
      for (const w of (snapshot?.workers || [])) {
        const list = w?.response?.workersContext?.playersSummary || []
        for (const p of list) {
          const status = String(p.status || (p.isPaused ? 'paused' : 'working'))
          const safeStatus = status.toLowerCase().replace(/[^a-z0-9_-]+/g, '')
          const progressPct =
            Number.isFinite(Number(p.progressPercent)) && Number(p.progressPercent) >= 0
              ? Math.max(0, Math.min(100, Number(p.progressPercent)))
              : 0
          const hasDuration = Number(p.duration || 0) > 0
          const artwork = p.artworkUrl
            ? '<img class="track-art" src="' + p.artworkUrl + '" alt="artwork" loading="lazy" referrerpolicy="no-referrer" />'
            : '<div class="track-art"></div>'
          rows.push({
            text:
              '<div class="track-card">' +
                '<div class="track-head">' +
                  artwork +
                  '<div class="track-meta">' +
                    '<div class="chips">' +
                      '<span class="tag">guild '+ (p.guildId || '-') +'</span>' +
                      '<span class="tag">'+ (p.sourceName || 'unknown') +'</span>' +
                      '<span class="tag">'+ (p.protocol || '-') +'</span>' +
                      '<span class="status status-' + safeStatus + '">' + status + '</span>' +
                    '</div>' +
                    '<div><b>'+ (p.title || '(no title)') +'</b></div>' +
                    '<div class="muted">' + (p.author || '-') + '</div>' +
                  '</div>' +
                '</div>' +
                '<div class="kv"><div class="k">position</div><div class="v">' +
                  fmtMs(p.position) + ' / ' + fmtMs(p.duration) +
                  (hasDuration ? (' <span class="muted">(' + fmtMs(p.remaining) + ' left)</span>') : '') +
                '</div></div>' +
                '<div class="progress"><i style="width:' + progressPct.toFixed(2) + '%"></i></div>' +
                '<div class="kv"><div class="k">uri</div><div class="v">'+ (p.uri || '(no uri)') +'</div></div>' +
                '<div class="kv"><div class="k">uri host</div><div class="v">'+ (p.uriHost || '-') +'</div></div>' +
                '<div class="kv"><div class="k">stream host</div><div class="v">'+ (p.streamUrlHost || '-') +'</div></div>' +
                '<div class="kv"><div class="k">codec</div><div class="v">' + (p.codec || '-') + '</div></div>' +
                '<div class="kv"><div class="k">container</div><div class="v">' + (p.container || '-') + '</div></div>' +
                '<div class="kv"><div class="k">format</div><div class="v">' + (p.formatLabel || p.format || '-') + '</div></div>' +
                '<div class="chips">' +
                  '<span class="tag">stream ' + (p.isStream ? 'yes' : 'no') + '</span>' +
                  '<span class="tag">seekable ' + (p.isSeekable ? 'yes' : 'no') + '</span>' +
                  '<span class="tag">ping ' + (Number.isFinite(Number(p.ping)) ? Number(p.ping).toFixed(0) : '-') + 'ms</span>' +
                '</div>' +
              '</div>'
          })
        }
      }
      setList(origins, rows)
    }

    function renderGroups(snapshot) {
      const bySource = new Map()
      const byProtocol = new Map()
      const byPair = new Map()

      for (const w of (snapshot?.workers || [])) {
        const list = w?.response?.workersContext?.playersSummary || []
        for (const p of list) {
          const source = p.sourceName || 'unknown'
          const protocol = p.protocol || 'unknown'
          bySource.set(source, (bySource.get(source) || 0) + 1)
          byProtocol.set(protocol, (byProtocol.get(protocol) || 0) + 1)
          const pair = source + '|' + protocol
          byPair.set(pair, (byPair.get(pair) || 0) + 1)
        }
      }

      const rows = []
      for (const [k,v] of Array.from(bySource.entries()).sort((a,b)=>b[1]-a[1]).slice(0,12)) {
        rows.push({ text: '<span class=\"tag\">source</span><b>'+k+'</b> <span class=\"muted\">players='+v+'</span>' })
      }
      for (const [k,v] of Array.from(byProtocol.entries()).sort((a,b)=>b[1]-a[1]).slice(0,12)) {
        rows.push({ text: '<span class=\"tag\">protocol</span><b>'+k+'</b> <span class=\"muted\">players='+v+'</span>' })
      }
      for (const [k,v] of Array.from(byPair.entries()).sort((a,b)=>b[1]-a[1]).slice(0,12)) {
        const [source, protocol] = k.split('|')
        rows.push({
          text:
            '<span class=\"tag\">pair</span><b>'+source+'</b> / <b>'+protocol+'</b> <span class=\"muted\">players='+v+'</span>'
        })
      }
      setList(groups, rows)
    }

    function renderWarnings(list) {
      updateWarningHistory(list || [])

      const entries = Array.from(warningState.values()).sort((a, b) => {
        const ta = Math.max(a.lastSeenAt || 0, a.resolvedAt || 0)
        const tb = Math.max(b.lastSeenAt || 0, b.resolvedAt || 0)
        return tb - ta
      })

      const rows = entries.map((w) => {
        const level =
          w.status === 'resolved'
            ? 'ok'
            : w.severity === 'error'
              ? 'error'
              : 'warn'
        const statusText = w.status === 'resolved' ? 'resolved' : 'active'
        const timeText =
          w.status === 'resolved'
            ? 'resolved at ' + fmtTime(w.resolvedAt)
            : 'last seen ' + fmtTime(w.lastSeenAt)
        return {
          level,
          text:
            '<div class="chips">' +
              '<span class="tag">' + w.type + '</span>' +
              '<span class="tag">' + w.kind + '</span>' +
              '<span class="tag">pid ' + w.pid + '</span>' +
              '<span class="tag">' + statusText + '</span>' +
            '</div>' +
            '<div><b>' + w.message + '</b></div>' +
            '<div class="muted">first seen ' + fmtTime(w.firstSeenAt) + ' | ' + timeText + '</div>'
        }
      })

      const activeCount = entries.filter((w) => w.status === 'active').length
      warnCount.textContent = String(activeCount)
      setList(warns, rows, '', 200)
    }

    function renderRequests(snapshot) {
      const reqs = snapshot?.master?.runtime?.trace?.requests || []
      traceCount.textContent = String(reqs.length)
      const rows = reqs.slice(-40).reverse().map((r) => ({
        level: Number(r.status) >= 400 ? 'error' : '',
        html:
          '<div class="chips">' +
            '<span class="tag">'+ (r.method || '-') +'</span>' +
            '<span class="tag">'+ (r.status || '-') +'</span>' +
            '<span class="tag">'+ (r.durationMs || 0) +'ms</span>' +
          '</div>' +
          '<div class="path-line">'+ (r.path || '-') +'</div>' +
          '<div class="meta-line">'+ (r.remoteAddress || '-') +' | reason=' + (r.reason || '-') +'</div>',
        text:
          '<div class="stack">' +
            '<div class="chips">' +
              '<span class="tag">'+ (r.method || '-') +'</span>' +
              '<span class="tag">'+ (r.status || '-') +'</span>' +
              '<span class="tag">'+ (r.durationMs || 0) +'ms</span>' +
            '</div>' +
            '<div class="kv"><div class="k">path</div><div class="v"><b>'+ (r.path || '-') +'</b></div></div>' +
            '<div class="kv"><div class="k">remote</div><div class="v">'+ (r.remoteAddress || '-') +'</div></div>' +
            '<div class="kv"><div class="k">reason</div><div class="v">'+ (r.reason || '-') +'</div></div>' +
          '</div>'
      }))
      setList(requests, rows, 'net', 120)

      const now = Date.now()
      for (const r of reqs.slice(-20)) {
        if (r.ts) reqTs.push(Number(r.ts))
      }
      while (reqTs.length && now - reqTs[0] > 10000) reqTs.shift()
      rps.textContent = (reqTs.length / 10).toFixed(1)
    }

    function renderEvents(snapshot) {
      const evs = snapshot?.master?.runtime?.trace?.events || []
      const rows = evs.slice(-60).reverse().map((e) => ({
        level: 'error',
        text:
          '<div class="stack">' +
            '<div class="chips">' +
              '<span class="tag">'+ (e.type || 'event') +'</span>' +
              '<span class="tag">'+ (e.method || '-') +'</span>' +
            '</div>' +
            '<div class="kv"><div class="k">path</div><div class="v"><b>'+ (e.path || '-') +'</b></div></div>' +
            '<div class="kv"><div class="k">message</div><div class="v">'+ (e.message || '-') +'</div></div>' +
          '</div>'
      }))
      setList(events, rows)
    }

    function updateCards(snapshot) {
      const point = buildChartPoint(snapshot)
      history.push(point)
      if (history.length > maxPoints) history.shift()
      setCardsFromPoint(point)
      renderTrace()
    }

    function classifyCallsite(site) {
      const base = ((site?.functionName || '') + ' ' + (site?.url || '')).toLowerCase()
      const tags = []
      if (base.includes('buffer')) tags.push('buffer')
      if (base.includes('concat')) tags.push('concat-copy')
      if (base.includes('array')) tags.push('array')
      if (base.includes('stream') || base.includes('pipe')) tags.push('stream/pipe')
      if (base.includes('webm') || base.includes('opus') || base.includes('demux')) tags.push('webm/opus')
      if (base.includes('gzip') || base.includes('zlib')) tags.push('compression')
      return tags
    }

    function extractTopSites(report) {
      const rows = []
      const stopped = report?.steps?.stopped
      const siteRow = (scope, scopeId, s) => {
        const safeUrl = String(s.url || '-').replace(/"/g, '&quot;')
        return {
          html:
            '<div class="chips">' +
              '<span class="tag">' + scope + (scopeId ? (' ' + scopeId) : '') + '</span>' +
              '<span class="tag">' + (s.bytes/1024/1024).toFixed(2) + 'MB</span>' +
              '<span class="tag">hits ' + (s.hits || 0) + '</span>' +
              classifyCallsite(s).map((tag) => '<span class="tag">' + tag + '</span>').join('') +
            '</div>' +
            '<div class="path-line">' + (s.functionName || '(anon)') + '</div>' +
            '<div class="meta-line"><span class="callsite" data-path="' + safeUrl + '" data-line="' + (s.line || 0) + '">' + (s.url || '-') + ':' + (s.line || 0) + '</span></div>'
        }
      }

      const m = stopped?.master
      if (m?.topSites) {
        for (const s of m.topSites) {
          rows.push(siteRow('master', '', s))
        }
      }

      for (const w of (stopped?.workers || [])) {
        for (const s of (w?.response?.topSites || [])) {
          rows.push(siteRow('worker', String(w.pid || '-'), s))
        }
      }

      for (const sWorker of (stopped?.sourceWorkers || [])) {
        for (const s of (sWorker?.response?.topSites || [])) {
          rows.push(siteRow('source', String(sWorker.pid || '-'), s))
        }
      }
      return rows
    }

    function renderAllocTopAuto(report) {
      if (!report) return
      latestAllocTop = report

      if (report.failed) {
        setList(allocSites, [{ level: 'error', text: 'allocTop failed: ' + (report.error || 'unknown') }])
        return
      }

      const rows = extractTopSites(report)
      setList(allocSites, rows, 'net', 240)
      const total = rows.length
      const sampleDuration = report?.durationMs || 0
      if (total > 0) {
        const marker = document.createElement('div')
        marker.className = 'item'
        marker.innerHTML =
          '<span class="tag">all</span><span class="tag">callsites ' +
          total +
          '</span><span class="tag">sample ' +
          sampleDuration +
          'ms</span>'
        allocSites.prepend(marker)
      }
      if (total === 0) {
        const stopped = report?.steps?.stopped || {}
        const explain = []
        if (stopped?.master?.error) explain.push('master: ' + stopped.master.error)
        for (const w of (stopped?.workers || [])) {
          if (w?.error || w?.response?.error) explain.push('worker ' + (w.pid || '-') + ': ' + (w.error || w.response.error))
        }
        for (const s of (stopped?.sourceWorkers || [])) {
          if (s?.error || s?.response?.error) explain.push('source ' + (s.pid || '-') + ': ' + (s.error || s.response.error))
        }
        if (explain.length === 0) explain.push('No allocations sampled in this interval (sample too short or process idle).')
        setList(allocSites, explain.map((text) => ({ level: 'warn', text })), '', 0)
      }

      const paths = []
      const stopped = report?.steps?.stopped
      if (stopped?.master?.outputPath) paths.push('master sample: ' + stopped.master.outputPath)
      for (const w of (stopped?.workers || [])) {
        if (w?.response?.outputPath) paths.push('worker ' + w.pid + ': ' + w.response.outputPath)
      }
      for (const s of (stopped?.sourceWorkers || [])) {
        if (s?.response?.outputPath) paths.push('source ' + s.pid + ': ' + s.response.outputPath)
      }
      setList(allReport, paths.map((text) => ({ text })))
    }

    async function openCallsite(pathValue, lineValue) {
      try {
        snippetMeta.textContent = 'Loading snippet...'
        const params = new URLSearchParams({
          code,
          path: pathValue,
          line: String(lineValue || 1),
          context: '10'
        })
        const res = await fetch('/v4/profiler/file?' + params.toString())
        const data = await res.json()
        if (!res.ok) throw new Error(data?.message || ('HTTP ' + res.status))

        snippetMeta.textContent = data.path + ' (line ' + data.line + ')'
        const out = []
        for (const row of (data.snippet || [])) {
          const n = String(row.number).padStart(5, ' ')
          const hitClass = row.number === data.line ? 'snippet-line-hit' : ''
          out.push('<span class=\"' + hitClass + '\">' + n + ' | ' + String(row.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>')
        }
        snippet.innerHTML = out.join('\\n')
      } catch (e) {
        snippetMeta.textContent = 'Failed to load snippet'
        snippet.textContent = String(e?.message || e)
      }
    }

    async function triggerAllocCapture() {
      if (captureInFlight) return
      captureInFlight = true
      if (captureMem) captureMem.textContent = 'capturing...'

      try {
        const res = await fetch('/v4/profiler?code=' + encodeURIComponent(code), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'allocTop',
            scope: 'all',
            durationMs: 3000,
            name: 'ui-manual'
          })
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.message || ('HTTP ' + res.status))
        renderAllocTopAuto(data)
      } catch (error) {
        setList(allocSites, [
          {
            level: 'error',
            text:
              'Manual capture failed: ' +
              (error instanceof Error ? error.message : String(error))
          }
        ])
      } finally {
        captureInFlight = false
        if (captureMem) captureMem.textContent = 'capture memory'
      }
    }

    function connect() {
      if (pageClosing) return
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url =
        proto +
        '//' +
        location.host +
        '/v4/profiler/socket?scope=all&intervalMs=2000&allocEveryMs=0&allocDurationMs=3000&code=' +
        encodeURIComponent(code)

      let reconnectTimer = null
      let watchdogTimer = null
      let reconnecting = false
      let lastMessageAt = Date.now()
      const staleTimeoutMs = 12000
      const ws = new WebSocket(url)

      const clearTimers = () => {
        if (watchdogTimer) {
          clearInterval(watchdogTimer)
          watchdogTimer = null
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
      }

      const scheduleReconnect = () => {
        if (pageClosing || reconnecting) return
        reconnecting = true
        conn.textContent = 'reconnecting...'
        conn.classList.remove('live')
        clearTimers()
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(4000, 'stale-reconnect')
          }
        } catch {}
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          if (!pageClosing) connect()
        }, 1500)
      }

      ws.onopen = () => {
        lastMessageAt = Date.now()
        conn.textContent = 'live'
        conn.classList.add('live')
        watchdogTimer = setInterval(() => {
          if (pageClosing || reconnecting) return
          if (Date.now() - lastMessageAt > staleTimeoutMs) {
            scheduleReconnect()
          }
        }, 3000)
      }

      ws.onmessage = (ev) => {
        lastMessageAt = Date.now()
        try {
          const payload = JSON.parse(ev.data)
          if (payload.op === 'profilerBootstrap') {
            const hist = Array.isArray(payload.history) ? payload.history : []
            history.length = 0
            for (const h of hist.slice(-maxPoints)) {
              const snap = h?.snapshot || h
              if (!snap) continue
              history.push(buildChartPoint(snap))
            }
            renderTrace()
            if (history.length > 0) setCardsFromPoint(history[history.length - 1])

            const lastEntry = hist.length > 0 ? hist[hist.length - 1] : null
            const lastSnapshot = lastEntry?.snapshot || null
            const lastWarnings = lastEntry?.warnings || []
            if (lastSnapshot) {
              renderProcessTable(lastSnapshot)
              renderV8Spaces(lastSnapshot)
              renderCaches(lastSnapshot)
              renderStreamLifecycle(lastSnapshot)
              renderBufferPool(lastSnapshot)
              renderDemux(lastSnapshot)
              renderOrigins(lastSnapshot)
              renderGroups(lastSnapshot)
              renderWarnings(lastWarnings)
              renderRequests(lastSnapshot)
              renderEvents(lastSnapshot)
            }
            if (payload.lastAllocTop) renderAllocTopAuto(payload.lastAllocTop)
            return
          }
          if (payload.op === 'profilerReady') return
          if (payload.op !== 'profilerSnapshot') return
          const snapshot = payload.snapshot
          updateCards(snapshot)
          renderProcessTable(snapshot)
          renderV8Spaces(snapshot)
          renderCaches(snapshot)
          renderStreamLifecycle(snapshot)
          renderBufferPool(snapshot)
          renderDemux(snapshot)
          renderOrigins(snapshot)
          renderGroups(snapshot)
          renderWarnings(payload.warnings || [])
          renderRequests(snapshot)
          renderEvents(snapshot)
          if (payload.allocTop) renderAllocTopAuto(payload.allocTop)
          saveLocalState(snapshot, payload.warnings || [], payload.allocTop || latestAllocTop)
        } catch {}
      }

      ws.onerror = () => {
        scheduleReconnect()
      }

      ws.onclose = () => {
        if (pageClosing) return
        scheduleReconnect()
      }
    }

    ;(() => {
      const local = loadLocalState()
      if (!local) return
      restoreWarningHistory(local.warningHistory || [])
      history.length = 0
      for (const p of (local.chartHistory || []).slice(-maxPoints)) {
        history.push({
          masterRss: Number(p?.masterRss || 0),
          workersHeap: Number(p?.workersHeap || 0),
          sourceHeap: Number(p?.sourceHeap || 0)
        })
      }
      if (history.length > 0) {
        setCardsFromPoint(history[history.length - 1])
        renderTrace()
      }
      if (local.lastSnapshot) {
        renderProcessTable(local.lastSnapshot)
        renderV8Spaces(local.lastSnapshot)
        renderCaches(local.lastSnapshot)
        renderStreamLifecycle(local.lastSnapshot)
        renderBufferPool(local.lastSnapshot)
        renderDemux(local.lastSnapshot)
        renderOrigins(local.lastSnapshot)
        renderGroups(local.lastSnapshot)
        renderWarnings(local.lastWarnings || [])
        renderRequests(local.lastSnapshot)
        renderEvents(local.lastSnapshot)
      }
      if (local.lastAllocTop) renderAllocTopAuto(local.lastAllocTop)
    })()

    allocSites.addEventListener('click', (ev) => {
      const target = ev.target
      if (!(target instanceof HTMLElement)) return
      if (!target.classList.contains('callsite')) return
      const path = target.getAttribute('data-path')
      const line = Number(target.getAttribute('data-line') || '1')
      if (!path || path === '-' || path === '(internal)') return
      openCallsite(path, line)
    })
    window.addEventListener('beforeunload', () => {
      pageClosing = true
    }, { once: true })

    connect()

    if (captureMem) {
      captureMem.addEventListener('click', () => {
        triggerAllocCapture().catch(() => {})
      })
    }
  </script>
</body>
</html>`;
}
async function handler(nodelink, req, res, _sendResponse, parsedUrl) {
    const endpointConfig = getEndpointConfig(nodelink);
    if (!endpointConfig.patchEnabled) {
        return sendErrorResponse(req, res, 403, 'Forbidden', 'Profiler endpoint is disabled.', parsedUrl.pathname);
    }
    const remoteAddress = req.socket?.remoteAddress || '';
    if (!endpointConfig.allowExternalPatch && !LOOPBACKS.has(remoteAddress)) {
        return sendErrorResponse(req, res, 403, 'Forbidden', 'External access to profiler UI is blocked.', parsedUrl.pathname);
    }
    const code = parsedUrl.searchParams.get('code');
    if (!code || code !== endpointConfig.code) {
        return sendErrorResponse(req, res, 403, 'Forbidden', 'Invalid or missing profiler code.', parsedUrl.pathname);
    }
    const html = buildPage(code);
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(html);
}
export default {
    handler,
    methods: ['GET']
};
