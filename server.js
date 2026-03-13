// IRON COMMAND — Multiplayer Relay Server with GUI Dashboard
// Run: node server.js
// Game clients connect via WebSocket
// Dashboard available at HTTP port
//
// Architecture: host-relay model
//   - Player1 (host) runs the full authoritative game simulation
//   - Player2 (guest) sends commands, receives snapshots from host
//   - This server only relays messages and manages rooms/lobbies
//   - No game logic runs on the server
//
// Deployment: works on localhost (LAN) and cloud (Render, Fly.io)
//   - Set PORT env var for cloud deployments (single port mode)
//   - Without PORT, uses separate WS (8080) and HTTP (8081) ports

const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const { exec } = require('child_process');

// Cloud hosts set PORT env var — use single port for both HTTP + WS
const CLOUD_PORT = process.env.PORT;
const WS_PORT = CLOUD_PORT || 8080;
const HTTP_PORT = CLOUD_PORT || process.env.DASH_PORT || 8081;
const IS_CLOUD = !!CLOUD_PORT;
const startedAt = Date.now();

// ── Stats tracking ────────────────────────────────────────────────────────────
let totalConnections = 0;
let totalRooms = 0;
let messagesRelayed = 0;
let activeConnections = 0;
const eventLog = []; // { time, msg }
const MAX_LOG = 200;

function logEvent(msg) {
  const ts = new Date().toLocaleTimeString();
  eventLog.unshift({ time: ts, msg });
  if (eventLog.length > MAX_LOG) eventLog.length = MAX_LOG;
  console.log(`[${ts}] ${msg}`);
}

// ── Rooms ─────────────────────────────────────────────────────────────────────
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateCode() : code;
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, excludeWs = null) {
  for (const p of room.players) {
    if (p.ws !== excludeWs) send(p.ws, obj);
  }
}

// Clean up stale rooms older than 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 2 * 60 * 60 * 1000) {
      rooms.delete(code);
      logEvent(`Room [${code}] expired (2h timeout)`);
      continue;
    }
    const alive = room.players.filter(p => p.ws.readyState === WebSocket.OPEN);
    if (alive.length === 0) {
      rooms.delete(code);
      logEvent(`Room [${code}] cleaned up (no connections)`);
    }
  }
}, 60_000);

// ── WebSocket message handler ─────────────────────────────────────────────────
function handleConnection(ws) {
  totalConnections++;
  activeConnections++;
  logEvent(`Client connected (${activeConnections} active)`);

  let playerRoom = null;
  let playerSide = null;
  let playerName = 'Commander';

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'CREATE_ROOM') {
      if (playerRoom) return;
      playerName = (msg.name || 'Commander').slice(0, 20);
      const code = generateCode();
      const room = { code, players: [{ ws, side: 'player', name: playerName }], started: false, createdAt: Date.now() };
      rooms.set(code, room);
      playerRoom = code;
      playerSide = 'player';
      totalRooms++;
      send(ws, { type: 'ROOM_CREATED', code, side: 'player' });
      logEvent(`Room [${code}] created by ${playerName}`);
      return;
    }

    if (msg.type === 'JOIN_ROOM') {
      if (playerRoom) return;
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: 'JOIN_ERROR', reason: 'Room not found.' }); return; }
      if (room.started) { send(ws, { type: 'JOIN_ERROR', reason: 'Game already in progress.' }); return; }
      if (room.players.length >= 2) { send(ws, { type: 'JOIN_ERROR', reason: 'Room is full.' }); return; }

      playerName = (msg.name || 'Commander').slice(0, 20);
      playerSide = 'player2';
      playerRoom = code;
      room.players.push({ ws, side: 'player2', name: playerName });
      room.started = true;

      const hostName = room.players[0].name;
      send(room.players[0].ws, { type: 'GAME_START', side: 'player', opponentName: playerName, isHost: true });
      send(ws, { type: 'GAME_START', side: 'player2', opponentName: hostName, isHost: false });
      logEvent(`Room [${code}] — ${playerName} joined. Game: ${hostName} vs ${playerName}`);
      return;
    }

    if (msg.type === 'PING') {
      send(ws, { type: 'PONG' });
      return;
    }

    // Relay in-game messages
    if (!playerRoom) return;
    const room = rooms.get(playerRoom);
    if (!room) return;
    messagesRelayed++;
    const relayed = { ...msg, fromSide: playerSide };
    broadcast(room, relayed, ws);
  });

  ws.on('close', () => {
    activeConnections--;
    logEvent(`${playerName} (${playerSide || 'unjoined'}) disconnected (${activeConnections} active)`);
    if (!playerRoom) return;
    const room = rooms.get(playerRoom);
    if (!room) return;
    broadcast(room, { type: 'PLAYER_DISCONNECTED', side: playerSide, name: playerName }, ws);
    room.players = room.players.filter(p => p.ws !== ws);
    if (room.players.length === 0) {
      rooms.delete(playerRoom);
      logEvent(`Room [${playerRoom}] closed`);
    }
  });

  ws.on('error', (err) => {
    logEvent(`WS error: ${err.message}`);
  });
}

// ── Helper: get local IP ──────────────────────────────────────────────────────
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

// ── HTTP Dashboard ────────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IRON COMMAND — Server</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: #0a0f14; color: #c8d6e5; font-family: 'Segoe UI', Consolas, monospace;
    min-height: 100vh;
  }
  ::selection { background: #2d6a4f; color: #fff; }

  /* Header */
  .header {
    background: linear-gradient(135deg, #0d1117 0%, #161b22 100%);
    border-bottom: 2px solid #1a5a2a;
    padding: 16px 24px;
    display: flex; align-items: center; gap: 16px;
  }
  .header h1 {
    font-size: 22px; color: #4ade80; letter-spacing: 3px; font-weight: 700;
  }
  .header .subtitle { color: #6b7280; font-size: 13px; margin-left: 8px; }
  .status-dot {
    width: 12px; height: 12px; border-radius: 50%; background: #22c55e;
    box-shadow: 0 0 8px #22c55e88; animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .header-right { margin-left: auto; display: flex; align-items: center; gap: 16px; }
  .header-right .info { font-size: 12px; color: #6b7280; text-align: right; line-height: 1.5; }
  .stop-btn {
    background: #7f1d1d; color: #fca5a5; border: 1px solid #991b1b;
    padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
    font-family: inherit; transition: all 0.2s;
  }
  .stop-btn:hover { background: #991b1b; color: #fff; }

  /* Main layout */
  .container { max-width: 1200px; margin: 0 auto; padding: 20px 24px; }

  /* Stats cards */
  .stats-row {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 14px; margin-bottom: 20px;
  }
  .stat-card {
    background: #111827; border: 1px solid #1f2937; border-radius: 10px;
    padding: 16px 20px; position: relative; overflow: hidden;
  }
  .stat-card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, #22c55e, #4ade80);
  }
  .stat-card.orange::before { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
  .stat-card.blue::before { background: linear-gradient(90deg, #3b82f6, #60a5fa); }
  .stat-card.purple::before { background: linear-gradient(90deg, #8b5cf6, #a78bfa); }
  .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #6b7280; margin-bottom: 6px; }
  .stat-value { font-size: 28px; font-weight: 700; color: #f0fdf4; }
  .stat-card.orange .stat-value { color: #fef3c7; }
  .stat-card.blue .stat-value { color: #dbeafe; }
  .stat-card.purple .stat-value { color: #ede9fe; }

  /* Sections */
  .section {
    background: #111827; border: 1px solid #1f2937; border-radius: 10px;
    margin-bottom: 16px; overflow: hidden;
  }
  .section-header {
    padding: 12px 18px; background: #161b22; border-bottom: 1px solid #1f2937;
    font-size: 13px; font-weight: 600; color: #9ca3af; text-transform: uppercase;
    letter-spacing: 1px; display: flex; align-items: center; gap: 8px;
  }
  .section-header .badge {
    background: #1a5a2a; color: #4ade80; padding: 2px 8px; border-radius: 10px;
    font-size: 11px; font-weight: 700;
  }

  /* Rooms table */
  .rooms-table { width: 100%; border-collapse: collapse; }
  .rooms-table th {
    text-align: left; padding: 10px 18px; font-size: 11px; color: #6b7280;
    text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #1f2937;
  }
  .rooms-table td {
    padding: 10px 18px; font-size: 13px; border-bottom: 1px solid #1f293744;
  }
  .rooms-table tr:hover td { background: #1f293744; }
  .room-code {
    font-weight: 700; color: #fbbf24; letter-spacing: 2px; font-size: 15px;
  }
  .status-waiting { color: #fbbf24; }
  .status-ingame { color: #4ade80; }
  .no-rooms { padding: 24px; text-align: center; color: #4b5563; font-size: 13px; }

  /* Event log */
  .log-container { max-height: 320px; overflow-y: auto; }
  .log-container::-webkit-scrollbar { width: 6px; }
  .log-container::-webkit-scrollbar-track { background: #111827; }
  .log-container::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
  .log-entry {
    padding: 6px 18px; font-size: 12px; border-bottom: 1px solid #1f293722;
    display: flex; gap: 12px;
  }
  .log-entry:hover { background: #1f293744; }
  .log-time { color: #4b5563; min-width: 75px; font-variant-numeric: tabular-nums; }
  .log-msg { color: #9ca3af; }
  .log-entry:nth-child(odd) { background: #0d111788; }
</style>
</head>
<body>

<div class="header">
  <div class="status-dot"></div>
  <h1>IRON COMMAND</h1>
  <span class="subtitle">RELAY SERVER</span>
  <div class="header-right">
    <div class="info">
      <div id="h-ip"></div>
      <div id="h-ports"></div>
    </div>
    <button class="stop-btn" onclick="stopServer()">STOP SERVER</button>
  </div>
</div>

<div class="container">
  <div class="stats-row">
    <div class="stat-card">
      <div class="stat-label">Uptime</div>
      <div class="stat-value" id="s-uptime">0:00:00</div>
    </div>
    <div class="stat-card orange">
      <div class="stat-label">Active Connections</div>
      <div class="stat-value" id="s-connections">0</div>
    </div>
    <div class="stat-card blue">
      <div class="stat-label">Active Rooms</div>
      <div class="stat-value" id="s-rooms">0</div>
    </div>
    <div class="stat-card purple">
      <div class="stat-label">Messages Relayed</div>
      <div class="stat-value" id="s-messages">0</div>
    </div>
  </div>
  <div class="stats-row">
    <div class="stat-card">
      <div class="stat-label">Total Connections</div>
      <div class="stat-value" id="s-totalconn">0</div>
    </div>
    <div class="stat-card orange">
      <div class="stat-label">Total Rooms Created</div>
      <div class="stat-value" id="s-totalrooms">0</div>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      Active Rooms <span class="badge" id="rooms-badge">0</span>
    </div>
    <div id="rooms-content">
      <div class="no-rooms">No active rooms</div>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      Event Log <span class="badge" id="log-badge">0</span>
    </div>
    <div class="log-container" id="log-container"></div>
  </div>
</div>

<script>
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}

function formatNumber(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n/1000).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 1) return s + 's';
  return m + 'm ' + (s % 60) + 's';
}

async function refresh() {
  try {
    const res = await fetch('/api/stats');
    const d = await res.json();

    document.getElementById('s-uptime').textContent = formatUptime(d.uptime);
    document.getElementById('s-connections').textContent = d.activeConnections;
    document.getElementById('s-rooms').textContent = d.activeRooms;
    document.getElementById('s-messages').textContent = formatNumber(d.messagesRelayed);
    document.getElementById('s-totalconn').textContent = formatNumber(d.totalConnections);
    document.getElementById('s-totalrooms').textContent = d.totalRooms;
    document.getElementById('h-ip').textContent = d.mode;
    document.getElementById('h-ports').textContent = 'Port: ' + d.port;
    document.getElementById('rooms-badge').textContent = d.activeRooms;
    document.getElementById('log-badge').textContent = d.log.length;

    // Rooms table
    const rc = document.getElementById('rooms-content');
    if (d.rooms.length === 0) {
      rc.innerHTML = '<div class="no-rooms">No active rooms — waiting for players to connect</div>';
    } else {
      let html = '<table class="rooms-table"><tr><th>Code</th><th>Players</th><th>Status</th><th>Duration</th></tr>';
      for (const r of d.rooms) {
        const status = r.started
          ? '<span class="status-ingame">IN GAME</span>'
          : '<span class="status-waiting">WAITING</span>';
        html += '<tr><td><span class="room-code">' + r.code + '</span></td>'
          + '<td>' + r.players.join(' vs ') + '</td>'
          + '<td>' + status + '</td>'
          + '<td>' + formatDuration(d.now - r.createdAt) + '</td></tr>';
      }
      html += '</table>';
      rc.innerHTML = html;
    }

    // Event log
    const lc = document.getElementById('log-container');
    let logHtml = '';
    for (const e of d.log) {
      logHtml += '<div class="log-entry"><span class="log-time">' + e.time + '</span><span class="log-msg">' + e.msg + '</span></div>';
    }
    lc.innerHTML = logHtml || '<div class="no-rooms">No events yet</div>';

  } catch(e) {
    document.getElementById('s-uptime').textContent = 'OFFLINE';
  }
}

async function stopServer() {
  if (!confirm('Stop the Iron Command server?')) return;
  try { await fetch('/api/stop'); } catch {}
  document.querySelector('.status-dot').style.background = '#ef4444';
  document.querySelector('.status-dot').style.boxShadow = '0 0 8px #ef444488';
  document.getElementById('s-uptime').textContent = 'STOPPED';
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

// ── HTTP Server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // CORS for all API endpoints
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Date.now() - startedAt }));
    return;
  }

  if (req.url === '/api/stats') {
    const roomsArr = [];
    for (const [code, room] of rooms) {
      roomsArr.push({
        code,
        players: room.players.map(p => p.name),
        started: room.started,
        createdAt: room.createdAt,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptime: Date.now() - startedAt,
      now: Date.now(),
      activeConnections,
      activeRooms: rooms.size,
      totalConnections,
      totalRooms,
      messagesRelayed,
      mode: IS_CLOUD ? 'Cloud Server' : 'LAN: ' + getLocalIP(),
      port: WS_PORT,
      rooms: roomsArr,
      log: eventLog.slice(0, 100),
    }));
    return;
  }

  if (req.url === '/api/discover') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'IRONCOMMAND_SERVER',
      name: IS_CLOUD ? 'Iron Command Online' : os.hostname(),
      ip: IS_CLOUD ? 'cloud' : getLocalIP(),
      wsPort: WS_PORT,
      activeRooms: rooms.size,
      activePlayers: activeConnections,
    }));
    return;
  }

  if (req.url === '/api/stop') {
    if (IS_CLOUD) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"Cannot stop cloud server from dashboard"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    logEvent('Server shutdown requested from dashboard');
    setTimeout(() => process.exit(0), 500);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── Startup mode: Cloud (single port) or LAN (separate ports) ─────────────────
if (IS_CLOUD) {
  // Cloud mode: HTTP + WebSocket share the same port
  const wss = new WebSocket.Server({ server: httpServer });
  wss.on('connection', handleConnection);

  httpServer.listen(CLOUD_PORT, () => {
    logEvent(`Cloud mode — HTTP + WebSocket on port ${CLOUD_PORT}`);
    logEvent('Ready for connections');
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║     IRON COMMAND — ONLINE SERVER         ║');
    console.log('  ╠══════════════════════════════════════════╣');
    console.log(`  ║  Port: ${String(CLOUD_PORT).padEnd(35)}║`);
    console.log('  ║  Mode: Cloud (single port)               ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
  });
} else {
  // LAN mode: separate WS and HTTP ports + UDP discovery
  const wss = new WebSocket.Server({ port: WS_PORT });
  wss.on('connection', handleConnection);

  wss.on('listening', () => {
    logEvent(`WebSocket relay listening on ws://localhost:${WS_PORT}`);
  });

  // UDP LAN Discovery (LAN only)
  try {
    const dgram = require('dgram');
    const DISCOVERY_PORT = 8082;
    const udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udpServer.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'IRONCOMMAND_DISCOVER') {
          const response = JSON.stringify({
            type: 'IRONCOMMAND_SERVER',
            name: os.hostname(),
            ip: getLocalIP(),
            wsPort: WS_PORT,
            activeRooms: rooms.size,
            activePlayers: activeConnections,
          });
          udpServer.send(response, rinfo.port, rinfo.address);
        }
      } catch {}
    });
    udpServer.on('error', (err) => {
      console.error(`UDP discovery error: ${err.message}`);
    });
    udpServer.bind(DISCOVERY_PORT, () => {
      udpServer.setBroadcast(true);
      logEvent(`LAN discovery listening on UDP port ${DISCOVERY_PORT}`);
    });
  } catch {}

  httpServer.listen(HTTP_PORT, () => {
    const ip = getLocalIP();
    logEvent(`Dashboard listening on http://localhost:${HTTP_PORT}`);
    logEvent(`Local IP: ${ip} — Players connect to ws://${ip}:${WS_PORT}`);
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║     IRON COMMAND — RELAY SERVER          ║');
    console.log('  ╠══════════════════════════════════════════╣');
    console.log(`  ║  WebSocket:  ws://localhost:${WS_PORT}          ║`);
    console.log(`  ║  Dashboard:  http://localhost:${HTTP_PORT}       ║`);
    console.log(`  ║  Local IP:   ${ip.padEnd(27)}║`);
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');

    // Auto-open dashboard in default browser (LAN only)
    const url = `http://localhost:${HTTP_PORT}`;
    switch (process.platform) {
      case 'win32': exec(`start "" "${url}"`); break;
      case 'darwin': exec(`open "${url}"`); break;
      default: exec(`xdg-open "${url}"`); break;
    }
  });
}
