// IRON COMMAND — Electron client + embedded relay server
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const dgram = require('dgram');

// Prevent multiple instances
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win;

// ══════════════════════════════════════════════════════════════════════════════
// EMBEDDED RELAY SERVER
// ══════════════════════════════════════════════════════════════════════════════
const WS_PORT = 8080;
const HTTP_PORT = 8081;
const DISCOVERY_PORT = 8082;
let serverRunning = false;
let wss = null;
let httpServer = null;
let udpServer = null;

// Stats
let totalConnections = 0;
let totalRooms = 0;
let messagesRelayed = 0;
let activeConnections = 0;
let serverStartedAt = 0;
const eventLog = [];
const MAX_LOG = 200;
const rooms = new Map();

function logEvent(msg) {
  const ts = new Date().toLocaleTimeString();
  eventLog.unshift({ time: ts, msg });
  if (eventLog.length > MAX_LOG) eventLog.length = MAX_LOG;
  console.log(`[Server ${ts}] ${msg}`);
}

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateCode() : code;
}

function wsSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, excludeWs = null) {
  for (const p of room.players) {
    if (p.ws !== excludeWs) wsSend(p.ws, obj);
  }
}

function startServer() {
  if (serverRunning) return;
  serverStartedAt = Date.now();
  totalConnections = 0;
  totalRooms = 0;
  messagesRelayed = 0;
  activeConnections = 0;
  eventLog.length = 0;
  rooms.clear();

  // ── WebSocket relay ───────────────────────────────────────────────────────
  wss = new WebSocket.Server({ port: WS_PORT });

  wss.on('connection', (ws) => {
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
        wsSend(ws, { type: 'ROOM_CREATED', code, side: 'player' });
        logEvent(`Room [${code}] created by ${playerName}`);
        notifyRenderer();
        return;
      }

      if (msg.type === 'JOIN_ROOM') {
        if (playerRoom) return;
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) { wsSend(ws, { type: 'JOIN_ERROR', reason: 'Room not found.' }); return; }
        if (room.started) { wsSend(ws, { type: 'JOIN_ERROR', reason: 'Game already in progress.' }); return; }
        if (room.players.length >= 2) { wsSend(ws, { type: 'JOIN_ERROR', reason: 'Room is full.' }); return; }

        playerName = (msg.name || 'Commander').slice(0, 20);
        playerSide = 'player2';
        playerRoom = code;
        room.players.push({ ws, side: 'player2', name: playerName });
        room.started = true;

        const hostName = room.players[0].name;
        wsSend(room.players[0].ws, { type: 'GAME_START', side: 'player', opponentName: playerName, isHost: true });
        wsSend(ws, { type: 'GAME_START', side: 'player2', opponentName: hostName, isHost: false });
        logEvent(`Room [${code}] — ${playerName} joined. Game: ${hostName} vs ${playerName}`);
        notifyRenderer();
        return;
      }

      if (msg.type === 'PING') {
        wsSend(ws, { type: 'PONG' });
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
      notifyRenderer();
    });

    ws.on('error', (err) => {
      logEvent(`WS error: ${err.message}`);
    });
  });

  // Clean up stale rooms
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.createdAt > 2 * 60 * 60 * 1000) {
        rooms.delete(code);
        logEvent(`Room [${code}] expired`);
        continue;
      }
      const alive = room.players.filter(p => p.ws.readyState === WebSocket.OPEN);
      if (alive.length === 0) {
        rooms.delete(code);
        logEvent(`Room [${code}] cleaned up`);
      }
    }
  }, 60_000);

  // ── HTTP discovery endpoint ───────────────────────────────────────────────
  httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/api/discover') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'IRONCOMMAND_SERVER',
        name: os.hostname(),
        ip: getLocalIP(),
        wsPort: WS_PORT,
        activeRooms: rooms.size,
        activePlayers: activeConnections,
      }));
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
        uptime: Date.now() - serverStartedAt,
        now: Date.now(),
        activeConnections,
        activeRooms: rooms.size,
        totalConnections,
        totalRooms,
        messagesRelayed,
        ip: getLocalIP(),
        wsPort: WS_PORT,
        rooms: roomsArr,
        log: eventLog.slice(0, 100),
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  httpServer.listen(HTTP_PORT);

  // ── UDP LAN discovery ─────────────────────────────────────────────────────
  udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
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
  udpServer.on('error', () => {});
  udpServer.bind(DISCOVERY_PORT, () => {
    udpServer.setBroadcast(true);
  });

  serverRunning = true;
  logEvent(`Server started — WS:${WS_PORT} HTTP:${HTTP_PORT} UDP:${DISCOVERY_PORT}`);
  logEvent(`Local IP: ${getLocalIP()}`);
  notifyRenderer();

  wss.on('error', (err) => {
    logEvent(`Server error: ${err.message}`);
  });
}

function stopServer() {
  if (!serverRunning) return;
  if (wss) { wss.close(); wss = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (udpServer) { udpServer.close(); udpServer = null; }
  rooms.clear();
  activeConnections = 0;
  serverRunning = false;
  logEvent('Server stopped');
  notifyRenderer();
}

function getServerStatus() {
  const roomsArr = [];
  for (const [code, room] of rooms) {
    roomsArr.push({
      code,
      players: room.players.map(p => p.name),
      started: room.started,
      createdAt: room.createdAt,
    });
  }
  return {
    running: serverRunning,
    uptime: serverRunning ? Date.now() - serverStartedAt : 0,
    ip: getLocalIP(),
    wsPort: WS_PORT,
    activeConnections,
    activeRooms: rooms.size,
    totalConnections,
    totalRooms,
    messagesRelayed,
    rooms: roomsArr,
    log: eventLog.slice(0, 50),
  };
}

function notifyRenderer() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('server-status', getServerStatus());
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ELECTRON WINDOW
// ══════════════════════════════════════════════════════════════════════════════
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'IRON COMMAND',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

// IPC handlers
ipcMain.handle('server-start', () => { startServer(); return getServerStatus(); });
ipcMain.handle('server-stop', () => { stopServer(); return getServerStatus(); });
ipcMain.handle('server-status', () => getServerStatus());

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
