'use strict';
// End-to-end: a scripted "human" plays a full game over WebSocket against 2 bots.
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:' + (process.env.PORT || 3000));
const send = (m) => ws.send(JSON.stringify(m));
let started = false, done = false, moves = 0, errors = [];
const timer = setTimeout(() => { console.log('TIMEOUT', moves, errors.slice(0, 3)); process.exit(1); }, 240000);
ws.on('open', () => send({ t: 'create', name: 'Tester' }));
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'error') errors.push(m.msg);
  if (m.t !== 'state') return;
  if (!m.game) {
    if (!started) { started = true; send({ t: 'addbot' }); send({ t: 'addbot' }); setTimeout(() => send({ t: 'start' }), 200); }
    return;
  }
  const g = m.game;
  if (g.winner) { console.log('game over, winner', g.winner, 'moves', moves, 'errors', errors.length, errors.slice(0, 3)); clearTimeout(timer); process.exit(0); }
  const play = (x) => { moves++; send({ t: 'g', m: x }); };
  const me = g.players.find((p) => p.id === m.you);
  if (g.stage === 'jsn' && g.pend.responder === m.you) return play({ t: 'jsn', use: g.hand.some((c) => c.act === 'jsn') });
  if (g.stage === 'pay' && g.pend.payer === m.you) return play({ t: 'pay', cards: g.suggest });
  if (g.turn !== m.you) return;
  if (g.stage === 'discard') return play({ t: 'discard', cards: g.hand.slice(0, g.hand.length - 7).map((c) => c.id) });
  if (g.stage !== 'play') return;
  const c = g.hand[0];
  if (!c || g.playsLeft < 1) return play({ t: 'end' });
  if (c.kind === 'prop') return play({ t: 'prop', card: c.id, color: c.colors[0] });
  if (c.kind === 'wild') return play({ t: 'prop', card: c.id, color: c.colors[0] });
  if (c.act === 'passgo') return play({ t: 'act', card: c.id });
  return play({ t: 'bank', card: c.id });
});
