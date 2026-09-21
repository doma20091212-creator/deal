'use strict';
// Game engine + bot AI. No I/O here: the server feeds it player messages and reads views.

const COLORS = ['brown', 'lblue', 'pink', 'orange', 'red', 'yellow', 'green', 'dblue', 'rr', 'util'];
const COLOR_NAME = {
  brown: 'Brown', lblue: 'Light Blue', pink: 'Pink', orange: 'Orange', red: 'Red',
  yellow: 'Yellow', green: 'Green', dblue: 'Dark Blue', rr: 'Railroad', util: 'Utility',
};
const SET_SIZE = { brown: 2, lblue: 3, pink: 3, orange: 3, red: 3, yellow: 3, green: 3, dblue: 2, rr: 4, util: 2 };
const RENT = {
  brown: [1, 2], lblue: [1, 2, 3], pink: [1, 2, 4], orange: [1, 3, 5], red: [2, 3, 6],
  yellow: [2, 4, 6], green: [2, 4, 7], dblue: [3, 8], rr: [1, 2, 3, 4], util: [1, 2],
};
const PROP_VALUE = { brown: 1, lblue: 1, pink: 2, orange: 2, red: 3, yellow: 3, green: 4, dblue: 4, rr: 2, util: 2 };
const ACTIONS = {
  dealbreaker: { name: 'Deal Breaker', value: 5, n: 2 },
  jsn: { name: 'Just Say No', value: 4, n: 3 },
  sly: { name: 'Sly Deal', value: 3, n: 3 },
  forced: { name: 'Forced Deal', value: 3, n: 3 },
  debt: { name: 'Debt Collector', value: 3, n: 3 },
  bday: { name: "It's My Birthday", value: 2, n: 3 },
  passgo: { name: 'Pass Go', value: 1, n: 10 },
  dblrent: { name: 'Double The Rent', value: 1, n: 2 },
  house: { name: 'House', value: 3, n: 3 },
  hotel: { name: 'Hotel', value: 4, n: 2 },
};
const HOUSE_RENT = 3;
const HOTEL_RENT = 4;
const WIN_SETS = 3;
const MAX_HAND = 7;
const PLAYS_PER_TURN = 3;
const PLAYERS_PER_DECK = 5; // every 5 players (or part of 5) adds another full deck
const MAX_PLAYERS = 10;
const TURN_MS = 40_000; // time to take a turn
const REACT_MS = 40_000; // time to answer Just Say No / pay a debt
const DISCARD_MS = 20_000; // time to discard down to the hand limit
const MIN_RESUME_MS = 10_000; // a turn resumed after reactions always gets at least this long

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck(copies = 1) {
  const cards = [];
  let n = 0;
  for (let d = 0; d < copies; d++) addDeck(cards, () => ++n);
  return cards;
}

function addDeck(cards, nextId) {
  const add = (o, count = 1) => { for (let i = 0; i < count; i++) cards.push({ id: nextId(), ...o }); };
  for (const [v, c] of [[1, 6], [2, 5], [3, 3], [4, 3], [5, 2], [10, 1]]) add({ kind: 'money', value: v, name: `$${v}M` }, c);
  const propCount = { brown: 2, lblue: 3, pink: 3, orange: 3, red: 3, yellow: 3, green: 3, dblue: 2, rr: 4, util: 2 };
  for (const c of COLORS) add({ kind: 'prop', colors: [c], as: c, value: PROP_VALUE[c], name: COLOR_NAME[c] }, propCount[c]);
  const wilds = [['pink', 'orange', 2, 2], ['lblue', 'brown', 1, 1], ['lblue', 'rr', 4, 1], ['red', 'yellow', 3, 2],
    ['dblue', 'green', 4, 1], ['green', 'rr', 4, 1], ['util', 'rr', 2, 1]];
  for (const [a, b, v, c] of wilds) add({ kind: 'wild', colors: [a, b], value: v, name: 'Wild' }, c);
  add({ kind: 'wild', colors: COLORS.slice(), value: 0, name: 'Wild' }, 2);
  for (const [act, d] of Object.entries(ACTIONS)) add({ kind: 'action', act, value: d.value, name: d.name }, d.n);
  for (const pair of [['brown', 'lblue'], ['pink', 'orange'], ['red', 'yellow'], ['green', 'dblue'], ['rr', 'util']]) {
    add({ kind: 'rent', colors: pair, value: 1, name: 'Rent' }, 2);
  }
  add({ kind: 'rent', colors: COLORS.slice(), value: 3, name: 'Wild Rent', wildRent: true }, 3);
}

const fail = (error) => ({ error });
const isProp = (c) => c.kind === 'prop' || c.kind === 'wild';
const cardLabel = (c) => {
  if (c.kind === 'money') return c.name;
  if (c.kind === 'prop') return `${COLOR_NAME[c.as]} property`;
  if (c.kind === 'wild') return c.colors.length > 2 ? 'a rainbow wild' : `wild ${c.colors.map((x) => COLOR_NAME[x]).join('/')}`;
  return c.name;
};

class Game {
  constructor(seats) {
    this.players = seats.map((s) => ({ id: s.id, name: s.name, bot: !!s.bot, hand: [], bank: [], groups: {} }));
    this.decks = Math.ceil(seats.length / PLAYERS_PER_DECK);
    this.deck = shuffle(buildDeck(this.decks));
    this.discard = [];
    this.log = [];
    this.seq = 0;
    this.saved = null; // turn time left while someone else reacts
    this.deadline = null;
    this.pend = null;
    this.winner = null;
    this.stage = 'play';
    this.turn = Math.floor(Math.random() * this.players.length);
    this.playsLeft = PLAYS_PER_TURN;
    for (const p of this.players) this.draw(p, 5);
    this.startTurn();
  }

  // ---------- small helpers ----------
  P(id) { return this.players.find((p) => p.id === id); }
  cur() { return this.players[this.turn]; }
  setDeadline(ms) { this.deadline = Date.now() + ms; }
  say(msg) { this.seq++; this.log.push(msg); if (this.log.length > 80) this.log.shift(); }
  others(p) { return this.players.filter((o) => o !== p); }

  draw(p, n) {
    let got = 0;
    for (let i = 0; i < n; i++) {
      if (!this.deck.length) {
        if (!this.discard.length) break;
        this.deck = shuffle(this.discard.splice(0));
      }
      p.hand.push(this.deck.pop());
      got++;
    }
    return got;
  }

  toDiscard(card) {
    if (card.kind === 'prop') card.as = card.colors[0];
    else if (card.kind === 'wild') delete card.as;
    this.discard.push(card);
  }

  takeHand(p, id) {
    const i = p.hand.findIndex((c) => c.id === id);
    return i < 0 ? null : p.hand.splice(i, 1)[0];
  }

  grp(p, color, create) {
    if (!p.groups[color] && create) p.groups[color] = { cards: [], house: null, hotel: null };
    return p.groups[color];
  }
  isComplete(p, color) { const g = p.groups[color]; return !!g && g.cards.length >= SET_SIZE[color]; }
  completeCount(p) { return COLORS.filter((c) => this.isComplete(p, c)).length; }
  allProps(p) { return Object.values(p.groups).flatMap((g) => g.cards); }
  findProp(p, id) {
    for (const [color, g] of Object.entries(p.groups)) {
      const card = g.cards.find((c) => c.id === id);
      if (card) return { color, card };
    }
    return null;
  }
  assetTotal(p) {
    return p.bank.reduce((s, c) => s + c.value, 0) + this.allProps(p).reduce((s, c) => s + c.value, 0);
  }

  rentOf(p, color) {
    const g = p.groups[color];
    if (!g || !g.cards.length) return 0;
    const n = Math.min(g.cards.length, SET_SIZE[color]);
    let r = RENT[color][n - 1];
    if (n >= SET_SIZE[color]) {
      if (g.house) r += HOUSE_RENT;
      if (g.hotel) r += HOTEL_RENT;
    }
    return r;
  }

  // Pick the color a wild card should take when it lands on p's table.
  autoColor(p, card) {
    if (card.colors.length === 1) return card.colors[0];
    let best = card.colors[0];
    let bestScore = -Infinity;
    for (const col of card.colors) {
      const g = p.groups[col];
      const score = !g ? 0 : g.cards.length >= SET_SIZE[col] ? -1 : g.cards.length + 1;
      if (score > bestScore) { bestScore = score; best = col; }
    }
    return best;
  }

  addProp(p, card, color) {
    card.as = color;
    this.grp(p, color, true).cards.push(card);
  }
  receive(p, card) { this.addProp(p, card, this.autoColor(p, card)); }

  // Improvements fall back into the bank when a set is broken; empty groups vanish.
  fixGroup(p, color) {
    const g = p.groups[color];
    if (!g) return;
    if (g.cards.length < SET_SIZE[color]) {
      if (g.house) { p.bank.push(g.house); g.house = null; }
      if (g.hotel) { p.bank.push(g.hotel); g.hotel = null; }
    }
    if (!g.cards.length) delete p.groups[color];
  }
  removeProp(p, card, fix = true) {
    const color = card.as;
    const g = p.groups[color];
    g.cards.splice(g.cards.indexOf(card), 1);
    if (fix) this.fixGroup(p, color);
    return color;
  }

  checkWin() {
    const order = [this.cur(), ...this.others(this.cur())];
    for (const p of order) {
      if (this.completeCount(p) >= WIN_SETS) {
        this.winner = p.id;
        this.stage = 'over';
        this.deadline = null;
        this.pend = null;
        this.say(`${p.name} wins with ${WIN_SETS} complete sets!`);
        return true;
      }
    }
    return false;
  }

  pendingActor() {
    if (this.stage === 'play' || this.stage === 'discard') return this.cur().id;
    if (this.stage === 'jsn') return this.pend.responder;
    if (this.stage === 'pay') return this.pend.payer;
    return null;
  }

  // Called by the server when the deadline passes: does the least harmful default for whoever is on the clock.
  expire() {
    if (this.stage === 'over' || !this.deadline || Date.now() < this.deadline) return false;
    const p = this.P(this.pendingActor());
    this.say(`${p.name} ran out of time.`);
    if (this.stage === 'jsn') this.act(p.id, { t: 'jsn', use: false });
    else if (this.stage === 'pay') this.act(p.id, { t: 'pay', cards: this.suggestPay(p, this.pend.amount) });
    else {
      if (this.stage === 'play') this.act(p.id, { t: 'end' });
      if (this.stage === 'discard') this.act(p.id, { t: 'discard', cards: autoDiscardIds(p) });
    }
    return true;
  }

  // ---------- turn flow ----------
  startTurn() {
    const p = this.cur();
    this.playsLeft = PLAYS_PER_TURN;
    this.stage = 'play';
    this.saved = null;
    this.setDeadline(TURN_MS);
    const n = p.hand.length === 0 ? 5 : 2;
    this.draw(p, n);
    this.say(`— ${p.name}'s turn (drew ${n}) —`);
  }
  nextTurn() {
    this.turn = (this.turn + 1) % this.players.length;
    this.startTurn();
  }

  // ---------- message entry point ----------
  act(pid, m) {
    if (this.stage === 'over') return fail('The game is over.');
    const p = this.P(pid);
    if (!p || !m) return fail('Unknown player.');
    switch (m.t) {
      case 'jsn': return this.actJsn(p, m);
      case 'pay': return this.actPay(p, m);
      case 'discard': return this.actDiscard(p, m);
      default: return this.actPlay(p, m);
    }
  }

  actPlay(p, m) {
    if (this.stage !== 'play') return fail('Not now.');
    if (this.cur() !== p) return fail('Not your turn.');
    if (m.t === 'end') {
      if (p.hand.length > MAX_HAND) { this.stage = 'discard'; this.setDeadline(DISCARD_MS); return { ok: true }; }
      this.nextTurn();
      return { ok: true };
    }
    if (m.t === 'move') return this.actMove(p, m);
    if (this.playsLeft < 1) return fail('No plays left this turn.');
    const card = p.hand.find((c) => c.id === m.card);
    if (!card) return fail('That card is not in your hand.');
    switch (m.t) {
      case 'bank': return this.actBank(p, card);
      case 'prop': return this.actProp(p, card, m);
      case 'act': return this.actAction(p, card, m);
      case 'rent': return this.actRent(p, card, m);
    }
    return fail('Unknown move.');
  }

  actMove(p, m) {
    const found = this.findProp(p, m.card);
    if (!found || found.card.kind !== 'wild') return fail('Only wild cards on your table can be moved.');
    if (!found.card.colors.includes(m.color) || m.color === found.color) return fail('Invalid color.');
    this.removeProp(p, found.card);
    this.addProp(p, found.card, m.color);
    this.say(`${p.name} moves a wild card to ${COLOR_NAME[m.color]}.`);
    this.checkWin();
    return { ok: true };
  }

  actBank(p, card) {
    if (isProp(card)) return fail("Property cards can't be banked.");
    this.takeHand(p, card.id);
    p.bank.push(card);
    this.playsLeft--;
    this.say(`${p.name} banks $${card.value}M.`);
    return { ok: true };
  }

  actProp(p, card, m) {
    if (!isProp(card)) return fail('Not a property card.');
    const color = card.kind === 'prop' ? card.colors[0] : m.color;
    if (!card.colors.includes(color)) return fail('Invalid color for that card.');
    this.takeHand(p, card.id);
    this.addProp(p, card, color);
    this.playsLeft--;
    this.say(`${p.name} plays ${card.kind === 'prop' ? `a ${COLOR_NAME[color]} property` : `${cardLabel(card)} as ${COLOR_NAME[color]}`}.`);
    this.checkWin();
    return { ok: true };
  }

  actAction(p, card, m) {
    if (card.kind !== 'action') return fail('Not an action card.');
    const target = m.target ? this.P(m.target) : null;
    const needTarget = () => (!target || target === p ? fail('Pick another player.') : null);
    switch (card.act) {
      case 'passgo': {
        this.takeHand(p, card.id); this.toDiscard(card); this.playsLeft--;
        const n = this.draw(p, 2);
        this.say(`${p.name} plays Pass Go and draws ${n}.`);
        return { ok: true };
      }
      case 'house':
      case 'hotel': {
        const color = m.color;
        const g = p.groups[color];
        const isHouse = card.act === 'house';
        if (!g || !this.isComplete(p, color)) return fail('You need a complete set.');
        if (color === 'rr' || color === 'util') return fail("Can't build on Railroads or Utilities.");
        if (isHouse ? g.house : !g.house || g.hotel) return fail(isHouse ? 'That set already has a house.' : 'Needs a house first (and only one hotel).');
        this.takeHand(p, card.id);
        g[isHouse ? 'house' : 'hotel'] = card;
        this.playsLeft--;
        this.say(`${p.name} builds a ${card.name} on ${COLOR_NAME[color]}.`);
        return { ok: true };
      }
      case 'dealbreaker': {
        const e = needTarget(); if (e) return e;
        if (!target.groups[m.color] || !this.isComplete(target, m.color)) return fail('They have no complete set of that color.');
        this.takeHand(p, card.id); this.toDiscard(card); this.playsLeft--;
        this.say(`${p.name} plays Deal Breaker on ${target.name}'s ${COLOR_NAME[m.color]} set!`);
        this.beginEffect(p, { t: 'dealbreaker', color: m.color }, [target]);
        return { ok: true };
      }
      case 'sly': {
        const e = needTarget(); if (e) return e;
        const f = this.findProp(target, m.theirs);
        if (!f || this.isComplete(target, f.color)) return fail("You can't take from a complete set.");
        this.takeHand(p, card.id); this.toDiscard(card); this.playsLeft--;
        this.say(`${p.name} plays Sly Deal, going after ${target.name}'s ${cardLabel(f.card)}.`);
        this.beginEffect(p, { t: 'sly', theirs: f.card }, [target]);
        return { ok: true };
      }
      case 'forced': {
        const e = needTarget(); if (e) return e;
        const mine = this.findProp(p, m.mine);
        const theirs = this.findProp(target, m.theirs);
        if (!mine || this.isComplete(p, mine.color)) return fail("Your card can't come from a complete set.");
        if (!theirs || this.isComplete(target, theirs.color)) return fail("Their card can't come from a complete set.");
        this.takeHand(p, card.id); this.toDiscard(card); this.playsLeft--;
        this.say(`${p.name} plays Forced Deal: their ${cardLabel(mine.card)} for ${target.name}'s ${cardLabel(theirs.card)}.`);
        this.beginEffect(p, { t: 'forced', mine: mine.card, theirs: theirs.card }, [target]);
        return { ok: true };
      }
      case 'debt': {
        const e = needTarget(); if (e) return e;
        this.takeHand(p, card.id); this.toDiscard(card); this.playsLeft--;
        this.say(`${p.name} plays Debt Collector on ${target.name} for $5M.`);
        this.beginEffect(p, { t: 'debt', amount: 5 }, [target]);
        return { ok: true };
      }
      case 'bday': {
        this.takeHand(p, card.id); this.toDiscard(card); this.playsLeft--;
        this.say(`${p.name} plays It's My Birthday — everyone owes $2M!`);
        this.beginEffect(p, { t: 'bday', amount: 2 }, this.others(p));
        return { ok: true };
      }
    }
    return fail("That card can't be played right now (bank it instead).");
  }

  actRent(p, card, m) {
    if (card.kind !== 'rent') return fail('Not a rent card.');
    if (!card.colors.includes(m.color)) return fail('That rent card does not cover that color.');
    const base = this.rentOf(p, m.color);
    if (!base) return fail("You don't own any properties of that color.");
    const doubles = [...new Set(m.doubles || [])].map((id) => p.hand.find((c) => c.id === id));
    if (doubles.length > 2 || doubles.some((c) => !c || c.act !== 'dblrent')) return fail('Invalid Double The Rent cards.');
    if (this.playsLeft < 1 + doubles.length) return fail("You don't have enough plays left for that.");
    let targets;
    if (card.wildRent) {
      const t = m.target ? this.P(m.target) : null;
      if (!t || t === p) return fail('Pick a player to charge.');
      targets = [t];
    } else {
      targets = this.others(p);
    }
    const amount = base * 2 ** doubles.length;
    for (const c of [card, ...doubles]) { this.takeHand(p, c.id); this.toDiscard(c); }
    this.playsLeft -= 1 + doubles.length;
    this.say(`${p.name} charges ${COLOR_NAME[m.color]} rent: $${amount}M${doubles.length ? ` (doubled ×${doubles.length})` : ''}${card.wildRent ? ` to ${targets[0].name}` : ' to everyone'}.`);
    this.beginEffect(p, { t: 'rent', amount, color: m.color }, targets);
    return { ok: true };
  }

  actDiscard(p, m) {
    if (this.stage !== 'discard' || this.cur() !== p) return fail('Not now.');
    const need = p.hand.length - MAX_HAND;
    const ids = [...new Set(m.cards || [])];
    if (ids.length !== need) return fail(`Discard exactly ${need} card${need === 1 ? '' : 's'}.`);
    if (ids.some((id) => !p.hand.some((c) => c.id === id))) return fail('Invalid card.');
    for (const id of ids) this.toDiscard(this.takeHand(p, id));
    this.say(`${p.name} discards ${need}.`);
    this.nextTurn();
    return { ok: true };
  }

  // ---------- effects: Just Say No window, then resolution ----------
  beginEffect(actor, eff, targets) {
    this.saved = Math.max(0, this.deadline - Date.now());
    this.pend = { actor: actor.id, eff, queue: targets.map((t) => t.id), cur: null, cancelled: false, responder: null, payer: null, amount: 0 };
    this.nextTarget();
  }

  nextTarget() {
    if (this.stage === 'over') return;
    const pd = this.pend;
    if (!pd.queue.length) {
      this.pend = null;
      this.stage = 'play';
      this.setDeadline(Math.max(this.saved ?? TURN_MS, MIN_RESUME_MS));
      this.saved = null;
      this.checkWin();
      return;
    }
    pd.cur = pd.queue.shift();
    pd.cancelled = false;
    pd.responder = pd.cur;
    pd.payer = null;
    this.stage = 'jsn';
    this.setDeadline(REACT_MS);
    this.autoJsn();
  }

  // Nobody is asked about Just Say No unless they actually hold one.
  autoJsn() {
    const r = this.P(this.pend.responder);
    if (!r.hand.some((c) => c.act === 'jsn')) this.resolveTarget();
  }

  actJsn(p, m) {
    if (this.stage !== 'jsn' || this.pend.responder !== p.id) return fail('Not now.');
    const pd = this.pend;
    if (!m.use) { this.resolveTarget(); return { ok: true }; }
    const card = p.hand.find((c) => c.act === 'jsn');
    if (!card) return fail("You don't have a Just Say No.");
    this.takeHand(p, card.id);
    this.toDiscard(card);
    pd.cancelled = !pd.cancelled;
    pd.responder = pd.responder === pd.cur ? pd.actor : pd.cur;
    this.setDeadline(REACT_MS);
    this.say(`${p.name} plays Just Say No!`);
    this.autoJsn();
    return { ok: true };
  }

  resolveTarget() {
    const pd = this.pend;
    const eff = pd.eff;
    const actor = this.P(pd.actor);
    const tgt = this.P(pd.cur);
    if (pd.cancelled) {
      this.say(`The action against ${tgt.name} is cancelled.`);
      return this.nextTarget();
    }
    switch (eff.t) {
      case 'rent': case 'debt': case 'bday':
        return this.startPay(tgt, eff.amount);
      case 'dealbreaker': {
        const g = tgt.groups[eff.color];
        if (g) {
          delete tgt.groups[eff.color];
          const dst = this.grp(actor, eff.color, true);
          dst.cards.push(...g.cards);
          for (const k of ['house', 'hotel']) {
            if (g[k]) { if (dst[k]) actor.bank.push(g[k]); else dst[k] = g[k]; }
          }
          this.say(`${actor.name} takes ${tgt.name}'s ${COLOR_NAME[eff.color]} set!`);
        }
        break;
      }
      case 'sly': {
        const f = this.findProp(tgt, eff.theirs.id);
        if (f) {
          this.removeProp(tgt, f.card);
          this.receive(actor, f.card);
          this.say(`${actor.name} steals ${tgt.name}'s ${cardLabel(f.card)}.`);
        }
        break;
      }
      case 'forced': {
        const a = this.findProp(actor, eff.mine.id);
        const b = this.findProp(tgt, eff.theirs.id);
        if (a && b) {
          this.removeProp(actor, a.card);
          this.removeProp(tgt, b.card);
          this.receive(actor, b.card);
          this.receive(tgt, a.card);
          this.say(`${actor.name} and ${tgt.name} swap properties.`);
        }
        break;
      }
    }
    if (this.checkWin()) return;
    this.nextTarget();
  }

  startPay(tgt, amount) {
    const total = this.assetTotal(tgt);
    if (total === 0) {
      this.say(`${tgt.name} has nothing to pay with.`);
      return this.nextTarget();
    }
    if (total <= amount) {
      this.say(`${tgt.name} can't cover $${amount}M and hands over everything.`);
      this.transfer(tgt, this.P(this.pend.actor), [...tgt.bank, ...this.allProps(tgt)]);
      if (this.checkWin()) return;
      return this.nextTarget();
    }
    this.stage = 'pay';
    this.pend.payer = tgt.id;
    this.pend.amount = amount;
    this.setDeadline(REACT_MS);
  }

  actPay(p, m) {
    if (this.stage !== 'pay' || this.pend.payer !== p.id) return fail('Not now.');
    const ids = [...new Set(m.cards || [])];
    const pool = [...p.bank, ...this.allProps(p)];
    const chosen = ids.map((id) => pool.find((c) => c.id === id));
    if (!chosen.length || chosen.some((c) => !c)) return fail('Pick cards from your bank or properties.');
    const sum = chosen.reduce((s, c) => s + c.value, 0);
    if (sum < this.pend.amount && chosen.length < pool.length) return fail(`You still owe $${this.pend.amount - sum}M more.`);
    const actor = this.P(this.pend.actor);
    this.say(`${p.name} pays ${chosen.length} card${chosen.length === 1 ? '' : 's'} ($${sum}M) to ${actor.name}.`);
    this.transfer(p, actor, chosen);
    if (this.checkWin()) return { ok: true };
    this.nextTarget();
    return { ok: true };
  }

  transfer(from, to, cards) {
    const touched = new Set();
    for (const c of [...cards]) {
      const bi = from.bank.indexOf(c);
      if (bi >= 0) {
        from.bank.splice(bi, 1);
        to.bank.push(c);
      } else {
        touched.add(this.removeProp(from, c, false));
        this.receive(to, c);
      }
    }
    for (const col of touched) this.fixGroup(from, col);
  }

  // Cheapest way for p to cover `amount`: min total "loss" subject to sum >= amount.
  suggestPay(p, amount) {
    const items = [
      ...p.bank.map((c) => ({ c, cost: c.value })),
      ...this.allProps(p).map((c) => ({ c, cost: c.value + 4 + (this.isComplete(p, c.as) ? 30 : 0) })),
    ].filter((it) => it.c.value > 0);
    const dp = new Array(amount + 1).fill(Infinity);
    const sel = new Array(amount + 1).fill(null);
    dp[0] = 0; sel[0] = [];
    items.forEach((it, i) => {
      for (let s = amount; s >= 0; s--) {
        if (dp[s] === Infinity) continue;
        const t = Math.min(amount, s + it.c.value);
        if (dp[s] + it.cost < dp[t]) { dp[t] = dp[s] + it.cost; sel[t] = sel[s].concat(i); }
      }
    });
    return (sel[amount] || items.map((_, i) => i)).map((i) => items[i].c.id);
  }

  // ---------- what each client is allowed to see ----------
  view(pid) {
    const pd = this.pend;
    const me = this.P(pid);
    const actor = this.stage === 'over' ? null : this.P(this.pendingActor());
    return {
      you: pid,
      turn: this.cur().id,
      timerFor: actor && !actor.bot ? actor.id : null,
      timeLeft: this.deadline ? Math.max(0, this.deadline - Date.now()) : null,
      stage: this.stage,
      playsLeft: this.playsLeft,
      deck: this.deck.length,
      discard: { count: this.discard.length, top: this.discard[this.discard.length - 1] || null },
      players: this.players.map((p) => ({
        id: p.id, name: p.name, bot: p.bot, handCount: p.hand.length,
        bank: p.bank, bankTotal: p.bank.reduce((s, c) => s + c.value, 0),
        groups: p.groups, sets: this.completeCount(p),
      })),
      hand: me ? me.hand : [],
      pend: pd ? {
        actor: pd.actor, cur: pd.cur, responder: pd.responder, payer: pd.payer, amount: pd.amount,
        cancelled: pd.cancelled, eff: pd.eff, left: pd.queue.length,
      } : null,
      suggest: this.stage === 'pay' && pd.payer === pid ? this.suggestPay(me, pd.amount) : null,
      log: this.log.slice(-40),
      seq: this.seq,
      winner: this.winner,
    };
  }
}

// =====================================================================
// Bot AI
// =====================================================================

function helpScore(g, me, card) {
  let best = { score: -Infinity, color: card.colors[0] };
  for (const col of card.colors) {
    const grp = me.groups[col];
    let score;
    if (!grp) score = card.value;
    else if (grp.cards.length >= SET_SIZE[col]) score = card.value - 5;
    else score = card.value + grp.cards.length * 3 + (grp.cards.length + 1 >= SET_SIZE[col] ? 20 : 0);
    if (score > best.score) best = { score, color: col };
  }
  return best;
}

function botPlayMove(g, p) {
  const me = p.id;
  if (g.playsLeft < 1) return { t: 'end' };
  const inHand = (fn) => p.hand.filter(fn);
  const act = (a) => p.hand.find((c) => c.act === a);
  const opps = g.others(p);
  const rich = () => opps.slice().sort((a, b) => g.assetTotal(b) - g.assetTotal(a));

  // 1. Draw more cards.
  const pg = act('passgo');
  if (pg) return { t: 'act', card: pg.id };

  // 2. Put properties down.
  const prop = inHand(isProp)[0];
  if (prop) return { t: 'prop', card: prop.id, color: helpScore(g, p, prop).color };

  // 3. Build on complete sets.
  for (const a of ['hotel', 'house']) {
    const c = act(a);
    if (!c) continue;
    const opts = COLORS.filter((col) => col !== 'rr' && col !== 'util' && g.isComplete(p, col) &&
      (a === 'house' ? !p.groups[col].house : p.groups[col].house && !p.groups[col].hotel));
    if (opts.length) return { t: 'act', card: c.id, color: opts.sort((x, y) => g.rentOf(p, y) - g.rentOf(p, x))[0] };
  }

  // 4. Deal Breaker.
  const db = act('dealbreaker');
  if (db) {
    let best = null;
    for (const o of opps) {
      for (const col of COLORS) {
        if (!g.isComplete(o, col)) continue;
        const score = g.rentOf(o, col) + (g.completeCount(p) + 1 >= WIN_SETS ? 100 : 0);
        if (!best || score > best.score) best = { score, o, col };
      }
    }
    if (best) return { t: 'act', card: db.id, target: best.o.id, color: best.col };
  }

  // 5. Sly Deal.
  const sly = act('sly');
  if (sly) {
    let best = null;
    for (const o of opps) {
      for (const [col, grp] of Object.entries(o.groups)) {
        if (grp.cards.length >= SET_SIZE[col]) continue;
        for (const c of grp.cards) {
          const score = helpScore(g, p, c).score + (grp.cards.length + 1 >= SET_SIZE[col] ? 4 : 0);
          if (!best || score > best.score) best = { score, o, c };
        }
      }
    }
    if (best) return { t: 'act', card: sly.id, target: best.o.id, theirs: best.c.id };
  }

  // 6. Forced Deal, only when it clearly helps.
  const fd = act('forced');
  if (fd) {
    let best = null;
    for (const o of opps) {
      for (const [col, grp] of Object.entries(o.groups)) {
        if (grp.cards.length >= SET_SIZE[col]) continue;
        for (const theirs of grp.cards) {
          const gain = helpScore(g, p, theirs).score;
          for (const [mcol, mg] of Object.entries(p.groups)) {
            if (mg.cards.length >= SET_SIZE[mcol]) continue;
            for (const mine of mg.cards) {
              const keep = mine.value + mg.cards.length * 3 + (mg.cards.length >= SET_SIZE[mcol] - 1 ? 15 : 0);
              if (mine.colors.includes(col)) continue;
              const net = gain - keep;
              if (net >= 8 && (!best || net > best.net)) best = { net, o, mine, theirs };
            }
          }
        }
      }
    }
    if (best) return { t: 'act', card: fd.id, target: best.o.id, mine: best.mine.id, theirs: best.theirs.id };
  }

  // 7. Rent.
  let bestRent = null;
  for (const c of inHand((x) => x.kind === 'rent')) {
    for (const col of c.colors) {
      const amount = g.rentOf(p, col);
      if (amount >= 2 && (!bestRent || amount > bestRent.amount)) bestRent = { c, col, amount };
    }
  }
  if (bestRent) {
    const dbl = inHand((x) => x.act === 'dblrent').slice(0, Math.min(2, g.playsLeft - 1));
    const useDbl = bestRent.amount >= 3 ? dbl : [];
    const m = { t: 'rent', card: bestRent.c.id, color: bestRent.col, doubles: useDbl.map((c) => c.id) };
    if (bestRent.c.wildRent) m.target = rich()[0].id;
    return m;
  }

  // 8. Money-grabbing actions.
  const dc = act('debt');
  const target = rich()[0];
  if (dc && target && g.assetTotal(target) >= 3) return { t: 'act', card: dc.id, target: target.id };
  const bd = act('bday');
  if (bd && opps.some((o) => g.assetTotal(o) > 0)) return { t: 'act', card: bd.id };

  // 9. Bank money (and surplus cards if the hand is overflowing).
  const money = inHand((c) => c.kind === 'money').sort((a, b) => b.value - a.value)[0];
  if (money) return { t: 'bank', card: money.id };
  if (p.hand.length > MAX_HAND) {
    const spare = p.hand.filter((c) => !isProp(c) && c.act !== 'jsn').sort((a, b) => a.value - b.value)[0];
    if (spare) return { t: 'bank', card: spare.id };
  }
  return { t: 'end' };
}

function botKeepScore(c) {
  if (c.act === 'jsn') return 20;
  if (c.act === 'dealbreaker') return 18;
  if (isProp(c)) return 15;
  if (c.kind === 'rent') return 8 + c.value;
  return c.value + (c.kind === 'action' ? 2 : 0);
}

// The cards least worth keeping, enough to get back down to the hand limit.
function autoDiscardIds(p) {
  return p.hand.slice().sort((a, b) => botKeepScore(a) - botKeepScore(b)).slice(0, p.hand.length - MAX_HAND).map((c) => c.id);
}

const bigEffect = (eff) => ['dealbreaker', 'sly', 'forced'].includes(eff.t) || (eff.amount || 0) >= 3;

// Performs exactly one decision for the bot; returns the engine result.
function botAct(g, p) {
  let r;
  switch (g.stage) {
    case 'jsn': {
      const has = p.hand.some((c) => c.act === 'jsn');
      r = g.act(p.id, { t: 'jsn', use: has && bigEffect(g.pend.eff) });
      if (r.error) r = g.act(p.id, { t: 'jsn', use: false });
      return r;
    }
    case 'pay':
      return g.act(p.id, { t: 'pay', cards: g.suggestPay(p, g.pend.amount) });
    case 'discard':
      return g.act(p.id, { t: 'discard', cards: autoDiscardIds(p) });
    case 'play':
      r = g.act(p.id, botPlayMove(g, p));
      if (r.error) r = g.act(p.id, { t: 'end' });
      return r;
  }
  return fail('Nothing to do.');
}

module.exports = { Game, botAct, COLORS, COLOR_NAME, SET_SIZE, RENT, ACTIONS, buildDeck, MAX_PLAYERS, PLAYERS_PER_DECK, TURN_MS };
