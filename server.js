'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, botAct, COLORS, COLOR_NAME, SET_SIZE, RENT, MAX_PLAYERS, PLAYERS_PER_DECK } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DROP_GRACE_MS = 30_000;
const EMPTY_ROOM_MS = 15 * 60_000;
const BOT_NAMES = ['Ada', 'Bolt', 'Chip', 'Dot', 'Echo', 'Fizz', 'Gizmo'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const token = () => crypto.randomBytes(12).toString('hex');
const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Player';

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    const code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    if (!rooms.has(code)) return code;
  }
}

function addPlayer(room, { name, bot, ws }) {
  const used = new Set(room.players.map((p) => p.id));
  let i = 1;
  while (used.has('p' + i)) i++;
  const p = { id: 'p' + i, token: bot ? null : token(), name, bot: !!bot, ws: ws || null, connected: !!ws, dropTimer: null };
  room.players.push(p);
  return p;
}

function broadcast(room) {
  const lobby = room.players.map((p) => ({ id: p.id, name: p.name, bot: p.bot, connected: p.bot || p.connected }));
  for (const p of room.players) {
    if (p.bot || !p.connected) continue;
    send(p.ws, { t: 'state', code: room.code, you: p.id, host: room.hostId, lobby, game: room.game ? room.game.view(p.id) : null });
  }
}

function scheduleBots(room) {
  if (room.botTimer || !room.game || room.game.stage === 'over') return;
  const actor = room.game.P(room.game.pendingActor());
  if (!actor || !actor.bot) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!room.game || room.game.stage === 'over') return;
    const who = room.game.P(room.game.pendingActor());
    if (who && who.bot) botAct(room.game, who);
    broadcast(room);
    scheduleBots(room);
  }, 900 + Math.random() * 600);
}

function removeRoomLater(room) {
  clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    if (room.players.every((p) => p.bot || !p.connected)) {
      clearTimeout(room.botTimer);
      rooms.delete(room.code);
    }
  }, EMPTY_ROOM_MS);
}

function onDrop(room, p) {
  p.connected = false;
  p.ws = null;
  clearTimeout(p.dropTimer);
  p.dropTimer = setTimeout(() => {
    if (p.connected) return;
    if (room.game) {
      // Seat gets taken over by a bot so the game keeps moving; the player can rejoin later.
      p.autoBot = true;
      const gp = room.game.P(p.id);
      if (gp) gp.bot = true;
      scheduleBots(room);
    } else {
      room.players.splice(room.players.indexOf(p), 1);
      if (room.hostId === p.id) {
        const next = room.players.find((x) => !x.bot);
        if (next) room.hostId = next.id;
      }
    }
    broadcast(room);
  }, DROP_GRACE_MS);
  if (room.players.every((x) => x.bot || !x.connected)) removeRoomLater(room);
  broadcast(room);
}

wss.on('connection', (ws) => {
  ws.ctx = null; // { room, player }
  send(ws, { t: 'hello', rules: { COLORS, COLOR_NAME, SET_SIZE, RENT, MAX_PLAYERS, PLAYERS_PER_DECK } });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try { handle(ws, m); } catch (e) { console.error(e); send(ws, { t: 'error', msg: 'Server error.' }); }
  });
  ws.on('close', () => {
    if (ws.ctx && ws.ctx.player.ws === ws) onDrop(ws.ctx.room, ws.ctx.player);
  });
});

function attach(ws, room, player) {
  if (player.ws && player.ws !== ws) { player.ws.ctx = null; player.ws.close(); }
  clearTimeout(player.dropTimer);
  player.ws = ws;
  player.connected = true;
  if (player.autoBot) {
    player.autoBot = false;
    const gp = room.game && room.game.P(player.id);
    if (gp) gp.bot = false;
  }
  ws.ctx = { room, player };
  clearTimeout(room.emptyTimer);
  send(ws, { t: 'joined', code: room.code, token: player.token });
}

function handle(ws, m) {
  const err = (msg) => send(ws, { t: 'error', msg });

  if (m.t === 'create') {
    if (ws.ctx) return err('Already in a room.');
    const room = { code: makeCode(), players: [], hostId: null, game: null, botTimer: null, emptyTimer: null };
    rooms.set(room.code, room);
    const p = addPlayer(room, { name: cleanName(m.name), ws });
    room.hostId = p.id;
    attach(ws, room, p);
    return broadcast(room);
  }

  if (m.t === 'join') {
    if (ws.ctx) return err('Already in a room.');
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return err('Room not found.');
    if (room.game) return err('That game has already started.');
    if (room.players.length >= MAX_PLAYERS) return err('Room is full.');
    const p = addPlayer(room, { name: cleanName(m.name), ws });
    attach(ws, room, p);
    return broadcast(room);
  }

  if (m.t === 'rejoin') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    const p = room && room.players.find((x) => !x.bot && x.token === m.token);
    if (!p) return send(ws, { t: 'gone' });
    attach(ws, room, p);
    return broadcast(room);
  }

  if (!ws.ctx) return err('Join a room first.');
  const { room, player } = ws.ctx;
  const isHost = room.hostId === player.id;

  switch (m.t) {
    case 'addbot': {
      if (!isHost || room.game) return;
      if (room.players.length >= MAX_PLAYERS) return err('Room is full.');
      const taken = new Set(room.players.map((p) => p.name));
      const name = BOT_NAMES.map((n) => `${n} (bot)`).find((n) => !taken.has(n)) || 'Bot';
      addPlayer(room, { name, bot: true });
      return broadcast(room);
    }
    case 'kick': {
      if (!isHost || room.game) return;
      const t = room.players.find((p) => p.id === m.id);
      if (!t || t.id === player.id) return;
      room.players.splice(room.players.indexOf(t), 1);
      if (t.ws) { t.ws.ctx = null; send(t.ws, { t: 'gone' }); }
      return broadcast(room);
    }
    case 'start': {
      if (!isHost || room.game) return;
      if (room.players.length < 2) return err('You need at least 2 players — add a bot!');
      room.game = new Game(room.players.map((p) => ({ id: p.id, name: p.name, bot: p.bot })));
      broadcast(room);
      return scheduleBots(room);
    }
    case 'lobby': {
      if (!isHost || !room.game || room.game.stage !== 'over') return;
      room.game = null;
      clearTimeout(room.botTimer); room.botTimer = null;
      room.players = room.players.filter((p) => p.bot || p.connected);
      return broadcast(room);
    }
    case 'leave': {
      room.players.splice(room.players.indexOf(player), 1);
      ws.ctx = null;
      if (room.game) {
        const gp = room.game.P(player.id);
        if (gp) gp.bot = true;
        room.players.push({ ...player, bot: true, connected: false, ws: null, token: null, name: player.name });
      }
      if (room.hostId === player.id) {
        const next = room.players.find((p) => !p.bot);
        if (next) room.hostId = next.id;
      }
      if (!room.players.some((p) => !p.bot)) { clearTimeout(room.botTimer); rooms.delete(room.code); }
      send(ws, { t: 'gone' });
      broadcast(room);
      return scheduleBots(room);
    }
    case 'g': {
      if (!room.game) return;
      const r = room.game.act(player.id, m.m);
      if (r.error) return err(r.error);
      broadcast(room);
      return scheduleBots(room);
    }
  }
}

server.listen(PORT, () => console.log(`Deal Online running on http://localhost:${PORT}`));
