'use strict';
// Simulates full bot-only games and checks engine invariants.
const { Game, botAct, buildDeck } = require('./game');

function countCards(g) {
  const ids = [];
  const push = (c) => ids.push(c.id);
  g.deck.forEach(push); g.discard.forEach(push);
  for (const p of g.players) {
    p.hand.forEach(push); p.bank.forEach(push);
    for (const gr of Object.values(p.groups)) { gr.cards.forEach(push); if (gr.house) push(gr.house); if (gr.hotel) push(gr.hotel); }
  }
  return ids;
}

const total = buildDeck().length;
const stats = { games: 0, wins: 0, stalled: 0, turns: [] };
for (let n = 0; n < 400; n++) {
  const count = 2 + (n % 4);
  const g = new Game(Array.from({ length: count }, (_, i) => ({ id: 'p' + i, name: 'Bot' + i, bot: true })));
  let steps = 0, turns = 0, last = g.turn;
  while (g.stage !== 'over' && steps < 20000) {
    const pid = g.pendingActor();
    const r = botAct(g, g.P(pid));
    if (r.error) throw new Error(`game ${n} step ${steps} stage ${g.stage}: ${r.error}`);
    const ids = countCards(g);
    if (ids.length !== total || new Set(ids).size !== total) throw new Error(`card conservation broken: ${ids.length}/${new Set(ids).size}`);
    if (g.turn !== last) { turns++; last = g.turn; }
    steps++;
  }
  stats.games++;
  if (g.stage === 'over') { stats.wins++; stats.turns.push(turns); } else stats.stalled++;
}
const avg = stats.turns.reduce((a, b) => a + b, 0) / stats.turns.length;
console.log(`deck=${total} games=${stats.games} finished=${stats.wins} stalled=${stats.stalled} avgTurns=${avg.toFixed(1)} max=${Math.max(...stats.turns)}`);
if (stats.stalled) process.exit(1);
