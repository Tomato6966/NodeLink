import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendErrorResponse } from "../utils.js";
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function loadUiCss() {
    const candidates = [
        path.resolve(process.cwd(), 'src/profiler/ui.css'),
        path.resolve(process.cwd(), 'dist/src/profiler/ui.css'),
        path.resolve(__dirname, '../profiler/ui.css')
    ];
    for (const filePath of candidates) {
        try {
            if (fs.existsSync(filePath)) {
                return fs.readFileSync(filePath, 'utf8');
            }
        }
        catch { }
    }
    return `
  body { margin: 0; background: #000; color: #fff; font-family: sans-serif; }
  `;
}
const uiCss = loadUiCss();
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
  <style>${uiCss}</style>
</head>
<body class="grain">
  <div class="wrap">
    <div class="top">
      <div class="title">NodeLink Live DevTools <small>cluster observability + trace</small></div>
      <div class="ctrl">
        <button id="captureMem" class="btn" type="button">capture memory</button>
        <div class="pill">allocTop manual / 3s sample</div>
        <div id="conn" class="pill">connecting...</div>
      </div>
    </div>

    <div id="tabs" class="tabs">
      <button class="tab active" data-tab="overview">overview (all)</button>
      <button class="tab" data-tab="memory">memory</button>
      <button class="tab" data-tab="traffic">traffic</button>
    </div>

    <div class="cards">
      <div class="card"><div class="label">Master RSS</div><div id="mRss" class="big">-</div><div class="sub">resident set</div></div>
      <div class="card"><div class="label">Workers Heap</div><div id="wHeap" class="big">-</div><div class="sub">sum heapUsed</div></div>
      <div class="card"><div class="label">Source Heap</div><div id="sHeap" class="big">-</div><div class="sub">source micro-workers</div></div>
      <div class="card"><div class="label">Warnings</div><div id="warnCount" class="big">0</div><div class="sub">anomaly detector</div></div>
      <div class="card"><div class="label">Req/s (window)</div><div id="rps" class="big">0.0</div><div class="sub">from request trace</div></div>
      <div class="card"><div class="label">Trace Buffer</div><div id="traceCount" class="big">0</div><div class="sub">network + events</div></div>
      <div class="card"><div class="label">Players Active</div><div id="playersActive" class="big">0</div><div class="sub">across workers</div></div>
      <div class="card"><div class="label">Heap Pressure</div><div id="heapPressure" class="big">0.0%</div><div class="sub">heapUsed/heapTotal</div></div>
    </div>

    <div class="mem-ribbon-wrap">
      <div class="mem-ribbon-top">
        <small id="memHeroUsedText" class="kid-edge left">← NodeLink active heap usage</small>
        <small id="memHeroAllocText" class="kid-edge right">Process RSS total (heap + native/runtime)</small>
      </div>
      <div class="mem-ribbon-bar">
        <i id="memHeroUsed"></i>
        <i id="memHeroGap"></i>
        <i id="memHeroOverhead"></i>
        <i id="memHeroMachineFree"></i>
      </div>
      <div class="mem-ribbon-legend">
        <span class="legend-chip"><i class="swatch used"></i>NodeLink used (heapUsed)</span>
        <span class="legend-chip"><i class="swatch free"></i>Heap reserved and still free</span>
        <span class="legend-chip"><i class="swatch over"></i>Tracked native (external + arrayBuffers)</span>
        <span class="legend-chip"><i class="swatch hostfree"></i>Host RAM free (machine)</span>
      </div>
      <div class="mem-ribbon-foot">
        <span id="memHeroLeftPct" class="kid-foot left">- actively used inside RSS</span>
        <span id="memHeroNoteRight" class="kid-center">High allocation does not always mean active usage. Node/panel/container setups (for example Pterodactyl) can keep large overhead allocated.</span>
        <span id="memHeroRightPct" class="kid-foot right">- tracked native inside RSS</span>
      </div>
    </div>

    <div class="layout">
      <div class="col">
        <div class="panel tab-panel" data-tab="overview,memory">
          <h3>Timeline Trace</h3>
          <div class="trace"><svg id="trace" viewBox="0 0 1000 260" preserveAspectRatio="none"></svg></div>
          <div class="legend">
            <span><i class="dot" style="background:#22d3ee"></i>Master RSS</span>
            <span><i class="dot" style="background:#f59e0b"></i>Workers Heap</span>
            <span><i class="dot" style="background:#a3e635"></i>Source Heap</span>
          </div>
        </div>

        <div class="panel tab-panel" data-tab="overview,memory">
          <h3>Process Explorer <span class="muted">master/workers/source with handles/resources</span></h3>
          <div class="table-wrap">
            <table id="procTable">
              <thead><tr><th>Type</th><th>PID</th><th>Heap</th><th>RSS</th><th>Ext/AB</th><th>Handles</th><th>Resources</th><th>Context</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>

        <div class="panel tab-panel" data-tab="memory">
          <h3>V8 Spaces</h3>
          <div id="v8Spaces" class="list list-scroll"></div>
        </div>

        <div class="panel tab-panel" data-tab="memory">
          <h3>Caches / Maps</h3>
          <div id="caches" class="list list-scroll"></div>
        </div>

        <div class="panel tab-panel" data-tab="memory">
          <h3>Stream Lifecycle</h3>
          <div id="streamLife" class="list list-scroll"></div>
        </div>

        <div class="panel tab-panel" data-tab="memory">
          <h3>Buffer Pool</h3>
          <div id="bufferPool" class="list list-scroll"></div>
        </div>

        <div class="panel tab-panel" data-tab="memory">
          <h3>Demux / WebmOpus</h3>
          <div id="demux" class="list list-scroll"></div>
        </div>

        <div class="panel tab-panel" data-tab="overview,traffic">
          <h3>Origins / Tracks (Where it comes from)</h3>
          <div id="origins" class="list list-scroll"></div>
        </div>

        <div class="panel tab-panel" data-tab="overview,traffic">
          <h3>Source / Protocol Groups</h3>
          <div id="groups" class="list list-scroll"></div>
        </div>
      </div>

      <div class="col">
        <div class="panel fill tab-panel" data-tab="memory">
          <h3>Memory Breakdown</h3>
          <div id="memBreakdown" class="list list-scroll"></div>
        </div>

        <div class="panel fill tab-panel" data-tab="traffic,overview">
          <h3>Trace Analytics</h3>
          <div id="traceAnalytics" class="list list-scroll"></div>
        </div>

        <div class="panel fill tab-panel" data-tab="traffic,memory,overview">
          <h3>Runtime Pressure (Live)</h3>
          <div id="runtimePressure" class="bars"></div>
        </div>

        <div class="panel fill tab-panel" data-tab="traffic,overview">
          <h3>Traffic Mix (Live)</h3>
          <div id="trafficMix" class="bars"></div>
        </div>

        <div class="panel fill tab-panel" data-tab="traffic">
          <h3>Socket Footprint</h3>
          <div id="socketFootprint" class="list list-scroll"></div>
        </div>

        <div class="panel fill tab-panel" data-tab="memory">
          <h3>Leak Signals</h3>
          <div id="leakSignals" class="list list-scroll"></div>
        </div>

        <div class="panel fill tab-panel" data-tab="overview,traffic,memory">
          <h3>Warnings & Heuristics</h3>
          <div id="warns" class="list list-scroll"></div>
        </div>

        <div class="panel fill tab-panel" data-tab="overview,traffic">
          <h3>Network Trace</h3>
          <div id="requests" class="list list-scroll" style="max-height:420px"></div>
        </div>

        <div class="panel fill tab-panel" data-tab="traffic,overview">
          <h3>Error Console / Events</h3>
          <div id="events" class="list list-scroll"></div>
        </div>

        <div class="panel tab-panel" data-tab="memory">
          <h3>Heap Artifacts (Auto)</h3>
          <div id="allReport" class="list list-scroll"></div>
        </div>

        <div class="panel tab-panel" data-tab="memory">
          <h3>Allocation Sites (ALL callsites)</h3>
          <div id="allocSites" class="list list-scroll"></div>
        </div>

        <div class="panel tab-panel" data-tab="memory">
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
    const tabs = document.getElementById('tabs')
    const traceSvg = document.getElementById('trace')
    const warns = document.getElementById('warns')
    const requests = document.getElementById('requests')
    const events = document.getElementById('events')
    const origins = document.getElementById('origins')
    const groups = document.getElementById('groups')
    const allReport = document.getElementById('allReport')
    const allocSites = document.getElementById('allocSites')
    const memBreakdown = document.getElementById('memBreakdown')
    const traceAnalytics = document.getElementById('traceAnalytics')
    const socketFootprint = document.getElementById('socketFootprint')
    const leakSignals = document.getElementById('leakSignals')
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
    const playersActive = document.getElementById('playersActive')
    const heapPressure = document.getElementById('heapPressure')
    const runtimePressure = document.getElementById('runtimePressure')
    const trafficMix = document.getElementById('trafficMix')
    const memHeroLeftPct = document.getElementById('memHeroLeftPct')
    const memHeroRightPct = document.getElementById('memHeroRightPct')
    const memHeroUsed = document.getElementById('memHeroUsed')
    const memHeroGap = document.getElementById('memHeroGap')
    const memHeroOverhead = document.getElementById('memHeroOverhead')
    const memHeroMachineFree = document.getElementById('memHeroMachineFree')
    const memHeroUsedText = document.getElementById('memHeroUsedText')
    const memHeroAllocText = document.getElementById('memHeroAllocText')
    const memHeroNoteRight = document.getElementById('memHeroNoteRight')

    const history = []
    const maxPoints = 180
    const reqTs = []
    let latestAllocTop = null
    let captureInFlight = false
    let pageClosing = false
    const warningState = new Map()
    const warningHistoryMax = 240
    const LOCAL_STATE_KEY = 'nodelink_profiler_ui_state_v2_' + location.host + '_' + code
    const TAB_STATE_KEY = 'nodelink_profiler_ui_tab_v1_' + location.host + '_' + code
    let currentTab = 'overview'

    const safePct = (v) => Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-'
    const uiFatal = (message) => {
      try {
        if (conn) {
          conn.textContent = 'ui error'
          conn.classList.remove('live')
        }
        const host = document.querySelector('.wrap')
        if (!host) return
        let box = document.getElementById('uiFatal')
        if (!box) {
          box = document.createElement('div')
          box.id = 'uiFatal'
          box.className = 'panel'
          box.style.marginBottom = '10px'
          host.insertBefore(box, host.firstChild)
        }
        box.innerHTML =
          '<h3>UI Runtime Error</h3>' +
          '<div class="item err"><b>Profiler UI failed to initialize</b><div class="muted">' +
          String(message || 'unknown error').replace(/</g, '&lt;') +
          '</div></div>'
      } catch {}
    }

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

    function drawArea(points, gradientId, maxY) {
      if (points.length < 2) return ''
      const w = 1000, h = 260
      const step = w / Math.max(points.length - 1, 1)
      let d = ''
      for (let i = 0; i < points.length; i++) {
        const x = i * step
        const y = h - Math.min(h, (points[i] / Math.max(maxY, 1)) * h)
        d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2)
      }
      d += ' L 1000,260 L 0,260 Z'
      return '<path d="' + d + '" fill="url(#' + gradientId + ')" opacity=".52"></path>'
    }

    function renderTrace() {
      const a = history.map(x => x.masterRss)
      const b = history.map(x => x.workersHeap)
      const c = history.map(x => x.sourceHeap)
      const maxY = Math.max(1, ...a, ...b, ...c)
      const defs =
        '<defs>' +
        '<linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#22d3ee" stop-opacity=".38"/><stop offset="100%" stop-color="#22d3ee" stop-opacity="0"/></linearGradient>' +
        '<linearGradient id="gb" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f59e0b" stop-opacity=".30"/><stop offset="100%" stop-color="#f59e0b" stop-opacity="0"/></linearGradient>' +
        '<linearGradient id="gc" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a3e635" stop-opacity=".28"/><stop offset="100%" stop-color="#a3e635" stop-opacity="0"/></linearGradient>' +
        '</defs>'
      traceSvg.innerHTML = [
        defs,
        drawArea(a, 'ga', maxY),
        drawArea(b, 'gb', maxY),
        drawArea(c, 'gc', maxY),
        drawLine(a, '#22d3ee', maxY),
        drawLine(b, '#f59e0b', maxY),
        drawLine(c, '#a3e635', maxY)
      ].join('')
    }

    function applyTab(tabName) {
      currentTab = tabName || 'overview'
      try { localStorage.setItem(TAB_STATE_KEY, currentTab) } catch {}

      const buttons = tabs ? tabs.querySelectorAll('.tab') : []
      for (const btn of buttons) {
        const isActive = btn.getAttribute('data-tab') === currentTab
        btn.classList.toggle('active', isActive)
      }

      const panels = document.querySelectorAll('.tab-panel')
      for (const panel of panels) {
        const tabAttr = String(panel.getAttribute('data-tab') || '')
        const visible =
          currentTab === 'overview' ||
          tabAttr.split(',').map(x => x.trim()).includes(currentTab)
        panel.classList.toggle('hidden', !visible)
      }
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

    function createBarRow(label, value, pct, tone = 'neutral') {
      const width = Math.max(0, Math.min(100, Number(pct) || 0))
      return (
        '<div class="bar-row">' +
          '<div class="bar-head"><span>' + label + '</span><span>' + value + '</span></div>' +
          '<div class="bar-track"><i class="bar-fill tone-' + tone + '" style="width:' + width.toFixed(2) + '%"></i></div>' +
        '</div>'
      )
    }

    function makeMemoryPie(rss, heapUsed, external, arrayBuffers) {
      const total = Math.max(Number(rss || 0), 1)
      const heap = Math.max(0, Number(heapUsed || 0))
      const extAb = Math.max(0, Number(external || 0) + Number(arrayBuffers || 0))
      const heapPct = Math.max(0, Math.min(100, (heap / total) * 100))
      const extPct = Math.max(0, Math.min(100 - heapPct, (extAb / total) * 100))
      const otherPct = Math.max(0, 100 - heapPct - extPct)
      return (
        '<div class="mem-pie" style="--heap:' + heapPct.toFixed(2) + ';--ext:' + extPct.toFixed(2) + ';--other:' + otherPct.toFixed(2) + ';">' +
          '<div class="mem-pie-center">' +
            '<b>' + mb(rss) + '</b>' +
            '<span>rss mb</span>' +
          '</div>' +
        '</div>'
      )
    }

    function renderRuntimePressure(snapshot) {
      if (!runtimePressure) return
      const procs = flattenProcesses(snapshot)
      let heapUsed = 0
      let heapTotal = 0
      let rss = 0
      let external = 0
      let arrayBuffers = 0
      let players = 0

      for (const p of procs) {
        heapUsed += Number(p?.memory?.heapUsed || 0)
        heapTotal += Number(p?.memory?.heapTotal || 0)
        rss += Number(p?.memory?.rss || 0)
        external += Number(p?.memory?.external || 0)
        arrayBuffers += Number(p?.memory?.arrayBuffers || 0)
      }
      for (const w of (snapshot?.workers || [])) {
        players += Number(w?.response?.workersContext?.playersCount || 0)
      }

      const heapRatio = heapTotal > 0 ? (heapUsed / heapTotal) * 100 : 0
      const extRssRatio = rss > 0 ? ((external + arrayBuffers) / rss) * 100 : 0
      const sourcePressure = (() => {
        let used = 0
        let total = 0
        for (const s of (snapshot?.sourceWorkers || [])) {
          used += Number(s?.response?.memory?.heapUsed || 0)
          total += Number(s?.response?.memory?.heapTotal || 0)
        }
        return total > 0 ? (used / total) * 100 : 0
      })()

      if (playersActive) playersActive.textContent = String(players)
      if (heapPressure) heapPressure.textContent = heapRatio.toFixed(1) + '%'

      const html = [
        createBarRow('Heap Used', mb(heapUsed) + ' MB', heapRatio, heapRatio > 85 ? 'bad' : heapRatio > 70 ? 'warn' : 'good'),
        createBarRow('Ext+AB vs RSS', extRssRatio.toFixed(1) + '%', extRssRatio, extRssRatio > 55 ? 'bad' : extRssRatio > 35 ? 'warn' : 'good'),
        createBarRow('Source Heap Pressure', sourcePressure.toFixed(1) + '%', sourcePressure, sourcePressure > 90 ? 'bad' : sourcePressure > 75 ? 'warn' : 'good'),
        createBarRow('Players Active', String(players), Math.min(100, players * 4), 'neutral')
      ].join('')
      runtimePressure.innerHTML = html
    }

    function renderMemoryHero(snapshot) {
      const procs = flattenProcesses(snapshot)
      let used = 0
      let allocated = 0
      let rss = 0
      let external = 0
      let arrayBuffers = 0

      for (const p of procs) {
        used += Number(p?.memory?.heapUsed || 0)
        allocated += Number(p?.memory?.heapTotal || 0)
        rss += Number(p?.memory?.rss || 0)
        external += Number(p?.memory?.external || 0)
        arrayBuffers += Number(p?.memory?.arrayBuffers || 0)
      }

      const safeRss = Math.max(rss, 1)
      const usedPct = Math.max(0, Math.min(100, (used / safeRss) * 100))
      const heapFreePct = Math.max(0, Math.min(100, ((allocated - used) / safeRss) * 100))
      const trackedNativePct = Math.max(0, Math.min(100, ((external + arrayBuffers) / safeRss) * 100))
      const unattributedPct = Math.max(0, Math.min(100, ((rss - allocated - external - arrayBuffers) / safeRss) * 100))
      const norm = usedPct + heapFreePct + trackedNativePct
      const scale = norm > 100 ? 100 / norm : 1
      const usedScaled = usedPct * scale
      const heapFreeScaled = heapFreePct * scale
      const trackedNativeScaled = trackedNativePct * scale

      if (memHeroLeftPct) memHeroLeftPct.textContent = usedPct.toFixed(1) + '% active heap inside RSS'
      if (memHeroRightPct) memHeroRightPct.textContent = trackedNativePct.toFixed(1) + '% tracked native (Ext/AB)'
      if (memHeroUsed) memHeroUsed.style.width = usedScaled.toFixed(2) + '%'
      if (memHeroGap) memHeroGap.style.width = heapFreeScaled.toFixed(2) + '%'
      if (memHeroOverhead) memHeroOverhead.style.width = trackedNativeScaled.toFixed(2) + '%'
      if (memHeroUsedText) memHeroUsedText.textContent = 'NodeLink active usage: ' + mb(used) + ' MB'
      if (memHeroAllocText) memHeroAllocText.textContent = 'Process RSS total: ' + mb(rss) + ' MB (heap reserved ' + mb(allocated) + ' MB)'

      const hostMem = snapshot?.master?.runtime?.hostMemory || {}
      const machineTotal = Number(hostMem.total || 0)
      const machineFree = Number(hostMem.free || 0)
      const machineTotalSafe = Math.max(machineTotal, 1)
      const machineFreePct = machineTotal > 0 ? Math.max(0, Math.min(100, (machineFree / machineTotalSafe) * 100)) : 0
      if (memHeroMachineFree) memHeroMachineFree.style.width = machineFreePct.toFixed(2) + '%'

      if (memHeroNoteRight) {
        const heapFree = Math.max(0, allocated - used)
        const heapFreePct = (heapFree / safeRss) * 100
        const note =
          'Blue=' + usedPct.toFixed(1) +
          '% active heap, Gray=' + heapFreePct.toFixed(1) +
          '% reserved heap free, Red=' + trackedNativePct.toFixed(1) +
          '% tracked native (Ext/AB), Unattributed RSS=' + Math.max(0, unattributedPct).toFixed(1) +
          (machineTotal > 0 ? '%, Host free=' + machineFreePct.toFixed(1) + '%.' : '%. Host free unavailable in this snapshot.') +
          ' High allocation does not always mean active use (Pterodactyl/container overhead can be high).'
        memHeroNoteRight.textContent = note
      }
    }

    function renderTrafficMix(snapshot) {
      if (!trafficMix) return
      const reqs = snapshot?.master?.runtime?.trace?.requests || []
      const methods = new Map()
      for (const r of reqs) {
        const method = String(r?.method || 'OTHER')
        methods.set(method, (methods.get(method) || 0) + 1)
      }
      const total = Math.max(1, reqs.length)
      const ordered = Array.from(methods.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6)
      if (ordered.length === 0) {
        trafficMix.innerHTML = '<div class="item">No traffic data yet.</div>'
        return
      }
      trafficMix.innerHTML = ordered
        .map(([method, count], idx) => {
          const pct = (count / total) * 100
          const tone = idx === 0 ? 'good' : idx === 1 ? 'warn' : 'neutral'
          return createBarRow(method, count + ' req', pct, tone)
        })
        .join('')
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

    function renderMemoryBreakdown(snapshot) {
      const rows = flattenProcesses(snapshot)
      const list = []
      const totals = {
        rss: 0,
        heapUsed: 0,
        heapTotal: 0,
        external: 0,
        arrayBuffers: 0
      }

      for (const row of rows) {
        const mem = row.memory || {}
        const rss = Number(mem.rss || 0)
        const heapUsed = Number(mem.heapUsed || 0)
        const heapTotal = Number(mem.heapTotal || 0)
        const external = Number(mem.external || 0)
        const arrayBuffers = Number(mem.arrayBuffers || 0)
        const extRatio = rss > 0 ? (external + arrayBuffers) / rss : 0
        const heapRatio = heapTotal > 0 ? heapUsed / heapTotal : 0

        totals.rss += rss
        totals.heapUsed += heapUsed
        totals.heapTotal += heapTotal
        totals.external += external
        totals.arrayBuffers += arrayBuffers

        list.push({
          html:
            '<div class="mem-card">' +
              '<div class="mem-card-top">' +
                '<div class="mem-id"><span class="tag">' + row.type + ' ' + (row.pid || '-') + '</span></div>' +
                makeMemoryPie(rss, heapUsed, external, arrayBuffers) +
              '</div>' +
              '<div class="mem-metrics">' +
                '<div class="mem-kv"><span>heap</span><b>' + mb(heapUsed) + ' / ' + mb(heapTotal) + ' MB</b></div>' +
                '<div class="mem-kv"><span>ext/ab</span><b>' + mb(external) + ' / ' + mb(arrayBuffers) + ' MB</b></div>' +
                '<div class="mem-kv"><span>heap pressure</span><b>' + safePct(heapRatio) + '</b></div>' +
                '<div class="mem-kv"><span>ext+ab vs rss</span><b>' + safePct(extRatio) + '</b></div>' +
              '</div>' +
            '</div>'
        })
      }

      const totalExtRatio =
        totals.rss > 0 ? (totals.external + totals.arrayBuffers) / totals.rss : 0
      const totalHeapRatio =
        totals.heapTotal > 0 ? totals.heapUsed / totals.heapTotal : 0

      list.unshift({
        html:
          '<div class="mem-card mem-total">' +
            '<div class="mem-card-top">' +
              '<div class="mem-id"><span class="tag">total footprint</span></div>' +
              makeMemoryPie(totals.rss, totals.heapUsed, totals.external, totals.arrayBuffers) +
            '</div>' +
            '<div class="mem-metrics">' +
              '<div class="mem-kv"><span>heap</span><b>' + mb(totals.heapUsed) + ' / ' + mb(totals.heapTotal) + ' MB</b></div>' +
              '<div class="mem-kv"><span>ext/ab</span><b>' + mb(totals.external) + ' / ' + mb(totals.arrayBuffers) + ' MB</b></div>' +
              '<div class="mem-kv"><span>heap pressure</span><b>' + safePct(totalHeapRatio) + '</b></div>' +
              '<div class="mem-kv"><span>ext+ab vs rss</span><b>' + safePct(totalExtRatio) + '</b></div>' +
            '</div>' +
          '</div>'
      })

      setList(memBreakdown, list, 'mem', 0)
    }

    function renderTraceAnalytics(snapshot) {
      const reqs = snapshot?.master?.runtime?.trace?.requests || []
      const rows = []
      const methods = new Map()
      const statuses = new Map()
      const reasons = new Map()
      const paths = new Map()
      const remotes = new Map()
      let totalDuration = 0

      for (const req of reqs) {
        const method = String(req.method || 'UNKNOWN')
        const status = String(req.status || '-')
        const reason = String(req.reason || '-')
        const path = String(req.path || '-')
        const remote = String(req.remoteAddress || '-')
        const dur = Number(req.durationMs || 0)

        methods.set(method, (methods.get(method) || 0) + 1)
        statuses.set(status, (statuses.get(status) || 0) + 1)
        reasons.set(reason, (reasons.get(reason) || 0) + 1)
        remotes.set(remote, (remotes.get(remote) || 0) + 1)
        const prev = paths.get(path) || { count: 0, duration: 0 }
        prev.count += 1
        prev.duration += dur
        paths.set(path, prev)
        totalDuration += dur
      }

      const total = reqs.length
      const avgDuration = total > 0 ? totalDuration / total : 0
      const errorCount = Array.from(statuses.entries()).reduce(
        (acc, [status, count]) => (Number(status) >= 400 ? acc + count : acc),
        0
      )
      rows.push({
        text:
          '<span class="tag">requests ' + total + '</span>' +
          '<span class="tag">errors ' + errorCount + '</span>' +
          '<span class="tag">error rate ' + safePct(total > 0 ? errorCount / total : 0) + '</span>' +
          '<span class="tag">avg ' + avgDuration.toFixed(1) + 'ms</span>'
      })

      const pushTop = (title, map, formatter) => {
        const ordered = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6)
        if (ordered.length === 0) return
        rows.push({ text: '<b>' + title + '</b>' })
        for (const [k, v] of ordered) {
          rows.push({ text: formatter(k, v) })
        }
      }

      pushTop('Methods', methods, (k, v) => '<span class="tag">' + k + '</span><span class="muted">count ' + v + '</span>')
      pushTop('Status', statuses, (k, v) => '<span class="tag">' + k + '</span><span class="muted">count ' + v + '</span>')
      pushTop(
        'Top Paths',
        new Map(
          Array.from(paths.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 8)
            .map(([path, data]) => [path, data.count])
        ),
        (k, v) => {
          const info = paths.get(k) || { duration: 0, count: 1 }
          const avg = info.duration / Math.max(1, info.count)
          return (
            '<div class="kv"><div class="k">path</div><div class="v"><b>' + k + '</b></div></div>' +
            '<span class="tag">count ' + v + '</span>' +
            '<span class="tag">avg ' + avg.toFixed(1) + 'ms</span>'
          )
        }
      )
      pushTop('Reasons', reasons, (k, v) => '<span class="tag">' + k + '</span><span class="muted">count ' + v + '</span>')
      pushTop('Remote IP', remotes, (k, v) => '<span class="tag">' + k + '</span><span class="muted">count ' + v + '</span>')

      setList(traceAnalytics, rows, '', 0)
    }

    function renderSocketFootprint(snapshot) {
      const rows = flattenProcesses(snapshot)
      const list = []
      const totals = {
        sockets: 0,
        tlsSockets: 0,
        tcpWrap: 0,
        handles: 0,
        resources: 0
      }

      for (const row of rows) {
        const handles = row.activeHandles || {}
        const resources = row.activeResources || {}
        const sockets = Number(handles.Socket || 0)
        const tlsSockets = Number(handles.TLSSocket || 0)
        const tcpWrap = Number(resources.TCPSocketWrap || 0)
        const handleCount = Object.values(handles).reduce((a, b) => a + Number(b || 0), 0)
        const resourceCount = Object.values(resources).reduce((a, b) => a + Number(b || 0), 0)

        totals.sockets += sockets
        totals.tlsSockets += tlsSockets
        totals.tcpWrap += tcpWrap
        totals.handles += handleCount
        totals.resources += resourceCount

        list.push({
          html:
            '<div class="socket-card">' +
              '<div class="socket-head"><span>' + row.type + ' ' + (row.pid || '-') + '</span><span>' + (sockets + tlsSockets) + ' sockets</span></div>' +
              '<div class="chips">' +
                '<span class="tag">socket ' + sockets + '</span>' +
                '<span class="tag">tls ' + tlsSockets + '</span>' +
                '<span class="tag">tcpWrap ' + tcpWrap + '</span>' +
                '<span class="tag">handles ' + handleCount + '</span>' +
                '<span class="tag">resources ' + resourceCount + '</span>' +
              '</div>' +
              '<div class="socket-meter"><i style="width:' + (Math.min(100, (sockets + tlsSockets) * 10)).toFixed(2) + '%"></i></div>' +
            '</div>'
        })
      }

      list.unshift({
        html:
          '<div class="socket-total">' +
            '<div class="socket-head"><span>total footprint</span><span>' + (totals.sockets + totals.tlsSockets) + ' sockets</span></div>' +
            '<div class="chips">' +
              '<span class="tag">socket ' + totals.sockets + '</span>' +
              '<span class="tag">tls ' + totals.tlsSockets + '</span>' +
              '<span class="tag">tcpWrap ' + totals.tcpWrap + '</span>' +
              '<span class="tag">handles ' + totals.handles + '</span>' +
              '<span class="tag">resources ' + totals.resources + '</span>' +
            '</div>' +
          '</div>'
      })

      setList(socketFootprint, list, 'socket', 0)
    }

    function renderLeakSignals(snapshot) {
      const rows = flattenProcesses(snapshot)
      const list = []
      const threshold = {
        extRatio: 0.45,
        heapRatio: 0.9,
        newSpaceRatio: 0.6
      }

      for (const row of rows) {
        const mem = row.memory || {}
        const rss = Number(mem.rss || 0)
        const heapUsed = Number(mem.heapUsed || 0)
        const heapTotal = Number(mem.heapTotal || 0)
        const external = Number(mem.external || 0)
        const arrayBuffers = Number(mem.arrayBuffers || 0)
        const extRatio = rss > 0 ? (external + arrayBuffers) / rss : 0
        const heapRatio = heapTotal > 0 ? heapUsed / heapTotal : 0

        const spaces =
          row.type === 'master'
            ? snapshot?.master?.heapSpaces || snapshot?.master?.runtime?.heapSpaces || []
            : row.type === 'worker'
              ? (snapshot?.workers || []).find((w) => Number(w.pid) === Number(row.pid))?.response?.heapSpaces || []
              : (snapshot?.sourceWorkers || []).find((s) => Number(s.pid) === Number(row.pid))?.response?.heapSpaces || []
        const newSpace = (spaces || []).find((s) => String(s.spaceName || '') === 'new_space') || null
        const newSpaceRatio =
          Number(newSpace?.spaceSize || 0) > 0
            ? Number(newSpace?.spaceUsedSize || 0) / Number(newSpace?.spaceSize || 0)
            : 0

        const flags = []
        if (extRatio >= threshold.extRatio) flags.push('ext/rss high')
        if (heapRatio >= threshold.heapRatio) flags.push('heap pressure')
        if (newSpaceRatio >= threshold.newSpaceRatio && Number(newSpace?.spaceSize || 0) >= 8 * 1024 * 1024) flags.push('new_space churn')
        if (flags.length === 0) continue

        list.push({
          level: 'warn',
          text:
            '<span class="tag">' + row.type + ' ' + (row.pid || '-') + '</span>' +
            flags.map((flag) => '<span class="tag">' + flag + '</span>').join('') +
            '<div class="muted">heap ' + safePct(heapRatio) + ' | ext/rss ' + safePct(extRatio) + ' | new_space ' + safePct(newSpaceRatio) + '</div>'
        })
      }

      if (list.length === 0) {
        setList(leakSignals, [{ level: 'ok', text: 'No high-risk retention signals in current snapshot.' }], '', 0)
        return
      }
      setList(leakSignals, list, '', 0)
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
          const redirectPayload = JSON.stringify({
            guildId: p.guildId || null,
            uri: p.uri || null,
            title: p.title || null,
            author: p.author || null,
            source: p.sourceName || null,
            protocol: p.protocol || null,
            position: Number(p.position || 0),
            duration: Number(p.duration || 0),
            seekable: Boolean(p.isSeekable)
          }).replace(/"/g, '&quot;')
          const streamHostUrl =
            p.streamUrlHost && p.streamUrlHost !== '-'
              ? 'https://' +
                String(p.streamUrlHost)
                  .replace('https://', '')
                  .replace('http://', '')
              : ''
          const progressLabel =
            fmtMs(p.position) + ' / ' + fmtMs(p.duration) +
            (hasDuration ? (' (' + fmtMs(p.remaining) + ' left)') : '')
          const quality =
            (p.codec || '-') + ' · ' + (p.container || '-') + ' · ' + (p.formatLabel || p.format || '-')
          rows.push({
            text:
              '<div class="track-card track-card-v2">' +
                '<div class="track-top">' +
                  artwork +
                  '<div class="track-main">' +
                    '<div class="track-main-top">' +
                      '<div class="chips">' +
                        '<span class="tag">worker ' + (w.pid || '-') + '</span>' +
                        '<span class="tag">guild '+ (p.guildId || '-') +'</span>' +
                        '<span class="tag">'+ (p.sourceName || 'unknown') +'</span>' +
                        '<span class="tag">'+ (p.protocol || '-') +'</span>' +
                      '</div>' +
                      '<span class="status status-' + safeStatus + '">' + status + '</span>' +
                    '</div>' +
                    '<div class="track-title">' + (p.title || '(no title)') + '</div>' +
                    '<div class="track-subtitle">' + (p.author || '-') + '</div>' +
                    '<div class="track-time"><span>position</span><span>' + progressLabel + '</span></div>' +
                    '<div class="progress"><i style="width:' + progressPct.toFixed(2) + '%"></i></div>' +
                    '<div class="track-controls">' +
                      (p.uri ? ('<a class="mini-btn" href="' + String(p.uri).replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">open</a>') : '') +
                      (p.artworkUrl ? ('<a class="mini-btn" href="' + String(p.artworkUrl).replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">artwork</a>') : '') +
                      (streamHostUrl ? ('<a class="mini-btn" href="' + streamHostUrl.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">stream host</a>') : '') +
                      '<button class="mini-btn" data-copy-kind="url" data-copy="' + String(p.uri || '').replace(/"/g, '&quot;') + '">copy url</button>' +
                      '<button class="mini-btn" data-copy-kind="title" data-copy="' + String(p.title || '').replace(/"/g, '&quot;') + '">copy title</button>' +
                      '<button class="mini-btn" data-copy-kind="author" data-copy="' + String(p.author || '').replace(/"/g, '&quot;') + '">copy author</button>' +
                      '<button class="mini-btn" data-copy-kind="guild" data-copy="' + String(p.guildId || '').replace(/"/g, '&quot;') + '">copy guild</button>' +
                      '<button class="mini-btn" data-copy-kind="payload" data-copy="' + redirectPayload + '">copy payload</button>' +
                    '</div>' +
                  '</div>' +
                '</div>' +
                '<div class="track-grid">' +
                  '<div class="track-kv"><span>uri</span><b>' + (p.uri || '(no uri)') + '</b></div>' +
                  '<div class="track-kv"><span>uri host</span><b>' + (p.uriHost || '-') + '</b></div>' +
                  '<div class="track-kv"><span>stream host</span><b>' + (p.streamUrlHost || '-') + '</b></div>' +
                  '<div class="track-kv"><span>quality</span><b>' + quality + '</b></div>' +
                '</div>' +
                '<div class="chips track-tech">' +
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
      const byStatus = new Map()
      let totalPlayers = 0

      for (const w of (snapshot?.workers || [])) {
        const list = w?.response?.workersContext?.playersSummary || []
        for (const p of list) {
          const source = p.sourceName || 'unknown'
          const protocol = p.protocol || 'unknown'
          const status = String(p.status || (p.isPaused ? 'paused' : 'working'))
          bySource.set(source, (bySource.get(source) || 0) + 1)
          byProtocol.set(protocol, (byProtocol.get(protocol) || 0) + 1)
          byStatus.set(status, (byStatus.get(status) || 0) + 1)
          const pair = source + '|' + protocol
          byPair.set(pair, (byPair.get(pair) || 0) + 1)
          totalPlayers += 1
        }
      }

      const renderDist = (title, map, formatter) => {
        const ordered = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8)
        const lines = ordered.map(([k, v], idx) => {
          const pct = totalPlayers > 0 ? (v / totalPlayers) * 100 : 0
          const tone = idx === 0 ? 'tone-good' : idx === 1 ? 'tone-warn' : 'tone-neutral'
          return (
            '<div class="group-line">' +
              '<div class="group-head"><span>' + formatter(k) + '</span><span>' + v + ' · ' + pct.toFixed(1) + '%</span></div>' +
              '<div class="group-meter"><i class="' + tone + '" style="width:' + pct.toFixed(2) + '%"></i></div>' +
            '</div>'
          )
        }).join('')

        return (
          '<div class="group-card">' +
            '<div class="group-title">' + title + '</div>' +
            (lines || '<div class="muted">No data</div>') +
          '</div>'
        )
      }

      const topPairs = new Map(Array.from(byPair.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8))
      const rows = [{
        html:
          '<div class="chips group-summary">' +
            '<span class="tag">players ' + totalPlayers + '</span>' +
            '<span class="tag">sources ' + bySource.size + '</span>' +
            '<span class="tag">protocols ' + byProtocol.size + '</span>' +
            '<span class="tag">pairs ' + byPair.size + '</span>' +
          '</div>'
      }]

      rows.push({
        html:
          '<div class="groups-grid groups-grid-v2">' +
            renderDist('Sources', bySource, (k) => k) +
            renderDist('Protocols', byProtocol, (k) => k) +
            renderDist('Player Status', byStatus, (k) => k) +
            renderDist('Top Source/Protocol Pairs', topPairs, (k) => {
              const [source, protocol] = k.split('|')
              return source + ' / ' + protocol
            }) +
          '</div>'
      })
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
      renderRuntimePressure(snapshot)
      renderTrafficMix(snapshot)
      renderMemoryHero(snapshot)
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
              renderMemoryBreakdown(lastSnapshot)
              renderTraceAnalytics(lastSnapshot)
              renderSocketFootprint(lastSnapshot)
              renderLeakSignals(lastSnapshot)
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
              renderRuntimePressure(lastSnapshot)
              renderTrafficMix(lastSnapshot)
              renderMemoryHero(lastSnapshot)
            }
            if (payload.lastAllocTop) renderAllocTopAuto(payload.lastAllocTop)
            return
          }
          if (payload.op === 'profilerReady') return
          if (payload.op !== 'profilerSnapshot') return
          const snapshot = payload.snapshot
          updateCards(snapshot)
          renderProcessTable(snapshot)
          renderMemoryBreakdown(snapshot)
          renderTraceAnalytics(snapshot)
          renderSocketFootprint(snapshot)
          renderLeakSignals(snapshot)
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
          renderRuntimePressure(snapshot)
          renderTrafficMix(snapshot)
          renderMemoryHero(snapshot)
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
        renderMemoryBreakdown(local.lastSnapshot)
        renderTraceAnalytics(local.lastSnapshot)
        renderSocketFootprint(local.lastSnapshot)
        renderLeakSignals(local.lastSnapshot)
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
        renderRuntimePressure(local.lastSnapshot)
        renderTrafficMix(local.lastSnapshot)
        renderMemoryHero(local.lastSnapshot)
      }
      if (local.lastAllocTop) renderAllocTopAuto(local.lastAllocTop)
    })()

    ;(() => {
      let saved = 'overview'
      try {
        const raw = localStorage.getItem(TAB_STATE_KEY)
        if (raw) saved = raw
      } catch {}
      applyTab(saved)

      if (tabs) {
        tabs.addEventListener('click', (ev) => {
          const target = ev.target
          if (!(target instanceof HTMLElement)) return
          if (!target.classList.contains('tab')) return
          const next = target.getAttribute('data-tab') || 'overview'
          applyTab(next)
        })
      }
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
    origins.addEventListener('click', async (ev) => {
      const target = ev.target
      if (!(target instanceof HTMLElement)) return
      const value = target.getAttribute('data-copy')
      if (value == null) return
      ev.preventDefault()
      try {
        await navigator.clipboard.writeText(value)
        const kind = target.getAttribute('data-copy-kind')
        const fallbackMap = {
          title: 'copy title',
          url: 'copy url',
          author: 'copy author',
          guild: 'copy guild',
          payload: 'copy payload'
        }
        const fallback = fallbackMap[kind] || 'copy'
        target.textContent = 'copied'
        setTimeout(() => {
          target.textContent = fallback
        }, 900)
      } catch {}
    })
    window.addEventListener('beforeunload', () => {
      pageClosing = true
    }, { once: true })

    window.addEventListener('error', (ev) => {
      uiFatal(ev?.error?.message || ev?.message || 'window error')
    })
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev?.reason
      const msg = reason && reason.message ? reason.message : String(reason || 'unhandled rejection')
      uiFatal(msg)
    })

    try {
      connect()
    } catch (err) {
      uiFatal(err?.message || err)
    }

    if (captureMem) {
      captureMem.addEventListener('click', () => {
        triggerAllocCapture().catch((err) => uiFatal(err?.message || err))
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
