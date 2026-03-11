const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;

// ─── HTTP SERVER ───────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'caida.html' : req.url);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// ─── DECK ─────────────────────────────────────────────────────────────────────
const SUITS = ['oros', 'copas', 'espadas', 'bastos'];
const VALUES = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];

function makeCard(suit, val) {
  const display = val === 10 ? '10-Sota' : val === 11 ? '11-Caballo' : val === 12 ? '12-Rey' : String(val);
  return { suit, val, display };
}
function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const v of VALUES) d.push(makeCard(s, v));
  return d;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── CARD HELPERS ─────────────────────────────────────────────────────────────
function isFigure(val) { return val >= 10; }

function caídaPoints(val) {
  if (val <= 7) return 1;
  if (val === 10) return 2;
  if (val === 11) return 3;
  if (val === 12) return 4;
  return 1;
}

function areConsecutive(vals) {
  if (vals.length < 2) return false;
  const s = [...vals].sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1] + 1) return false;
  return true;
}

function analyzeCantos(hand) {
  const vals = hand.map(c => c.val);
  const counts = {};
  vals.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const cv = Object.values(counts).sort((a, b) => b - a);

  if (cv[0] === 3) {
    const v = parseInt(Object.keys(counts).find(k => counts[k] === 3));
    return { type: 'tibilin', rank: 100, pts: 0, val: v, desc: `Tibilín de ${v}` };
  }
  if (cv[0] === 2) {
    const pv = parseInt(Object.keys(counts).find(k => counts[k] === 2));
    const sv = parseInt(Object.keys(counts).find(k => counts[k] === 1));
    if (Math.abs(pv - sv) === 1)
      return { type: 'vigia', rank: 3, pts: 7, val: pv, desc: `Vigía de ${pv}` };
    const pts = isFigure(pv) ? caídaPoints(pv) : 1;
    return { type: 'ronda', rank: 2, pts, val: pv, desc: `Ronda de ${pv}` };
  }
  if (areConsecutive(vals))
    return { type: 'patrulla', rank: 4, pts: 6, val: Math.max(...vals), desc: `Patrulla ${Math.min(...vals)}-${Math.max(...vals)}` };
  return null;
}

function compareCantos(a, b) {
  if (!a && !b) return 0; if (!a) return -1; if (!b) return 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.val - b.val;
}

// ─── ROOMS ────────────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(code, maxPlayers) {
  maxPlayers = [2, 3, 4].includes(maxPlayers) ? maxPlayers : 4;
  return {
    code, maxPlayers,
    players: [],
    state: 'waiting',
    deck: [],
    tableCards: [],
    round: 0,
    dealer: 0,
    currentTurn: 0,
    lastPlayedCard: null,
    lastPlayedBy: -1,
    lastCollectorIdx: -1,
    isLastTanda: false,
    scores: [],
    teamMode: false,
    puestoState: 'choosing',
    puestoDirection: null,
    puestoTargets: [],
    puestoTargetIdx: 0,
    puestoTarget: null,
    puestoRevealed: [],
    puestoResult: null,
    cantosDone: false,
    cantoResults: [],
    roundLog: [],
    readyForNext: [],
  };
}

function broadcast(room, msg) {
  room.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); });
}
function sendTo(p, msg) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
function addLog(room, msg) { broadcast(room, { type: 'log', msg }); }
function addRoundLog(room, entry) { room.roundLog.push(entry); }

// ─── STATE ────────────────────────────────────────────────────────────────────
function buildStateFor(room, player) {
  const myIdx = room.players.indexOf(player);
  return {
    roomCode: room.code, maxPlayers: room.maxPlayers,
    gameState: room.state, teamMode: room.teamMode,
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name, team: p.team,
      cardCount: p.hand ? p.hand.length : 0,
      collectedCount: p.collected ? p.collected.length : 0,
      isYou: p.id === player.id,
      hand: p.id === player.id ? p.hand : null,
      canto: p.canto || null,
    })),
    tableCards: room.tableCards,
    scores: room.scores,
    currentTurn: room.currentTurn,
    dealer: room.dealer,
    manoIdx: room.players.length > 0 ? (room.dealer + 1) % room.players.length : 0,
    lastPlayedCard: room.lastPlayedCard,
    lastPlayedBy: room.lastPlayedBy,
    myIdx,
    cantosDone: room.cantosDone,
    cantoResults: room.cantoResults || [],
    puestoState: room.puestoState,
    puestoDirection: room.puestoDirection,
    puestoTarget: room.puestoTarget,
    puestoRevealed: room.puestoRevealed || [],
    puestoResult: room.puestoResult,
    round: room.round,
    cardsInDeck: room.deck.length,
    isLastTanda: room.isLastTanda,
  };
}
function sendState(room) {
  room.players.forEach(p => sendTo(p, { type: 'state', state: buildStateFor(room, p) }));
}

// ─── GAME START ───────────────────────────────────────────────────────────────
function startGame(room) {
  const n = room.players.length;
  room.teamMode = n === 4;
  room.players.forEach((p, i) => { p.team = room.teamMode ? i % 2 : i; p.collected = []; p.canto = null; });
  room.scores = room.players.map(() => 0);
  room.round = 0; room.dealer = 0;
  addLog(room, `🎮 ¡Comienza la Caída! ${n} jugadores`);
  dealRound(room);
}

// ─── DEAL ROUND ───────────────────────────────────────────────────────────────
function dealRound(room) {
  room.deck = shuffle(makeDeck());
  room.tableCards = [];
  room.lastPlayedCard = null; room.lastPlayedBy = -1; room.lastCollectorIdx = -1;
  room.isLastTanda = false;
  room.cantosDone = false; room.cantoResults = [];
  room.roundLog = []; room.readyForNext = [];
  room.puestoState = 'choosing'; room.puestoDirection = null;
  room.puestoTarget = null; room.puestoRevealed = []; room.puestoResult = null;
  room.players.forEach(p => { p.hand = []; p.collected = []; p.canto = null; });

  addLog(room, `🃏 Reparto ${room.round + 1} — Repartidor: ${room.players[room.dealer].name}`);
  room.state = 'puesto_choosing';
  sendState(room);
  broadcast(room, { type: 'puesto_choose', dealerIdx: room.dealer, dealerName: room.players[room.dealer].name });
}

// ─── PUESTO ───────────────────────────────────────────────────────────────────
function startPuesto(room, direction) {
  room.puestoDirection = direction;
  room.puestoRevealed = [];
  room.puestoState = 'revealing';
  room.puestoTargets = direction === 'asc' ? [1, 2, 3, 4] : [4, 3, 2, 1];
  room.puestoTargetIdx = 0;
  room.puestoTarget = room.puestoTargets[0];
  addLog(room, `🎯 Puesto ${direction === 'asc' ? '1→4' : '4→1'}: buscando el ${room.puestoTarget}...`);
  sendState(room);
  setTimeout(() => revealNextPuestoCard(room), 800);
}

function revealNextPuestoCard(room) {
  if (room.deck.length === 0) { finishPuesto(room, false); return; }
  const card = room.deck.splice(0, 1)[0];
  room.puestoRevealed.push(card);
  const target = room.puestoTarget;

  broadcast(room, { type: 'puesto_card_revealed', card, target, revealed: room.puestoRevealed });
  sendState(room);

  if (card.val === target) {
    const pts = target;
    room.scores[room.dealer] += pts;
    addRoundLog(room, { event: 'Puesto', player: room.players[room.dealer].name, pts, detail: `${card.display} = ${target}` });
    addLog(room, `✅ ¡PUESTO! ${card.display} coincide con ${target} — +${pts} pts para ${room.players[room.dealer].name}`);
    room.tableCards = [...room.puestoRevealed];
    setTimeout(() => finishPuesto(room, true), 800);
  } else {
    room.puestoTargetIdx++;
    if (room.puestoTargetIdx >= room.puestoTargets.length) {
      const manoIdx = (room.dealer + 1) % room.players.length;
      room.scores[manoIdx] += 1;
      addRoundLog(room, { event: 'Puesto fallido', player: room.players[manoIdx].name, pts: 1, detail: 'Repartidor no acertó' });
      addLog(room, `❌ Puesto fallido — +1 para la mano (${room.players[manoIdx].name})`);
      room.tableCards = [...room.puestoRevealed];
      setTimeout(() => finishPuesto(room, false), 800);
    } else {
      room.puestoTarget = room.puestoTargets[room.puestoTargetIdx];
      addLog(room, `  ↳ No es ${target}, buscando el ${room.puestoTarget}...`);
      sendState(room);
      setTimeout(() => revealNextPuestoCard(room), 1200);
    }
  }
}

function finishPuesto(room, hit) {
  room.puestoState = 'done';
  while (room.tableCards.length < 4 && room.deck.length > 0)
    room.tableCards.push(room.deck.splice(0, 1)[0]);
  room.puestoResult = { hit, direction: room.puestoDirection };
  addLog(room, `🃏 Mesa inicial: ${room.tableCards.map(c => c.display).join(', ')}`);
  sendState(room);
  setTimeout(() => dealTanda(room), 1200);
}

// ─── TANDA ────────────────────────────────────────────────────────────────────
function dealTanda(room) {
  const n = room.players.length;
  room.isLastTanda = room.deck.length < n * 3;

  room.players.forEach(p => {
    p.canto = null;
    p.hand = room.deck.splice(0, Math.min(3, room.deck.length));
  });

  // 3p leftover
  if (n === 3 && room.deck.length === 1) {
    room.players[room.dealer].hand.push(room.deck.pop());
    addLog(room, `🃏 Carta sobrante al repartidor`);
  }

  room.players.forEach(p => { p.canto = p.hand.length >= 3 ? analyzeCantos(p.hand) : null; });
  room.cantosDone = false; room.cantoResults = [];
  room.state = 'cantos';
  room.currentTurn = (room.dealer + 1) % n;

  if (room.players.every(p => p.hand.length === 0)) { endRound(room); return; }

  addLog(room, `🃏 Tanda${room.isLastTanda ? ' final' : ''} repartida`);
  sendState(room);
  resolveCantos(room);
}

// ─── CANTOS ───────────────────────────────────────────────────────────────────
function resolveCantos(room) {
  const n = room.players.length;
  const manoIdx = (room.dealer + 1) % n;
  const withCanto = room.players.map((p, i) => ({ p, i, canto: p.canto })).filter(x => x.canto);

  if (withCanto.length === 0) {
    room.cantosDone = true; room.state = 'playing';
    addLog(room, '▶️ Sin cantos — ¡a jugar!');
    sendState(room); return;
  }

  const tibilines = withCanto.filter(x => x.canto.type === 'tibilin');
  if (tibilines.length > 0) {
    const winner = tibilines.reduce((b, c) => ((c.i - manoIdx + n) % n) < ((b.i - manoIdx + n) % n) ? c : b);
    room.scores[winner.i] += 10;
    addRoundLog(room, { event: 'Tibilín', player: winner.p.name, pts: 10, detail: winner.canto.desc });
    addLog(room, `🃏 ¡TIBILÍN! ${winner.p.name} — +10 pts. ¡Gana el reparto!`);
    room.cantoResults = [{ player: winner.p.name, canto: winner.canto.desc, pts: 10, won: true }];
    room.cantosDone = true;
    endRound(room); return;
  }

  let best = null;
  withCanto.forEach(x => { if (compareCantos(x.canto, best) > 0) best = x.canto; });
  const top = withCanto.filter(x => compareCantos(x.canto, best) === 0);
  const winner = top.reduce((b, c) => ((c.i - manoIdx + n) % n) < ((b.i - manoIdx + n) % n) ? c : b);

  let totalPts = winner.canto.pts;
  const results = [];
  withCanto.forEach(x => {
    if (x.i === winner.i) {
      results.push({ player: x.p.name, canto: x.canto.desc, pts: x.canto.pts, won: true });
    } else {
      totalPts += x.canto.pts;
      results.push({ player: x.p.name, canto: x.canto.desc, pts: x.canto.pts, won: false, killedBy: winner.p.name });
    }
  });

  room.scores[winner.i] += totalPts;
  addRoundLog(room, { event: 'Cantos', player: winner.p.name, pts: totalPts, detail: winner.canto.desc });
  addLog(room, `🎺 ${winner.p.name} gana cantos con ${winner.canto.desc} — +${totalPts} pts`);
  withCanto.filter(x => x.i !== winner.i).forEach(x => addLog(room, `  ↳ Mata ${x.canto.desc} de ${x.p.name}`));

  room.cantoResults = results;
  room.cantosDone = true;
  room.state = 'playing';
  sendState(room);
}

// ─── PLAY CARD ────────────────────────────────────────────────────────────────
function playCard(room, playerIdx, cardIndex) {
  const player = room.players[playerIdx];
  const card = player.hand[cardIndex];
  if (!card) return;
  const n = room.players.length;

  player.hand.splice(cardIndex, 1);
  addLog(room, `🃏 ${player.name} juega ${card.display} de ${card.suit}`);

  // ── CAÍDA ──
  let caida = false;
  if (room.lastPlayedBy !== -1 && room.lastPlayedCard && room.lastPlayedCard.val === card.val) {
    const pts = caídaPoints(card.val);
    room.scores[playerIdx] += pts;
    caida = true;
    addRoundLog(room, { event: 'Caída', player: player.name, pts, detail: `${card.display} sobre ${room.players[room.lastPlayedBy].name}` });
    addLog(room, `💥 ¡CAÍDA! ${player.name} cae sobre ${room.players[room.lastPlayedBy].name} — +${pts} pt`);
    broadcast(room, { type: 'caida', by: player.name, on: room.players[room.lastPlayedBy].name, card, pts });
  }

  // ── COLLECT FROM TABLE ──
  let collected = [];
  const sameOnTable = room.tableCards.filter(c => c.val === card.val);

  if (sameOnTable.length > 0) {
    collected = [...sameOnTable, card];
    room.tableCards = room.tableCards.filter(c => c.val !== card.val);
    addLog(room, `✅ ${player.name} limpia con ${card.display}`);
  } else {
    // Escalera: la carta jugada debe ser el INICIO de una secuencia en la mesa.
    // Recoge card.val, card.val+1, card.val+2, ... mientras existan en la mesa.
    // La carta jugada NO tiene que estar ya en la mesa, actúa como inicio.
    const tableValsSet = new Set(room.tableCards.map(c => c.val));
    // Build run starting at card.val going UP through table cards
    let runVals = [];
    let v = card.val;
    // card itself starts the run
    runVals.push(v);
    v++;
    while (v <= 12 && tableValsSet.has(v)) { runVals.push(v); v++; }
    // Only collect if there are at least 2 table cards above the played card
    const tableRunVals = runVals.slice(1); // exclude the played card itself
    if (tableRunVals.length >= 2) {
      tableRunVals.forEach(rv => {
        const found = room.tableCards.find(c => c.val === rv);
        if (found) { collected.push(found); room.tableCards = room.tableCards.filter(c => c !== found); }
      });
      collected.push(card);
      addLog(room, `🎯 ${player.name} recoge escalera ${card.val}-${runVals[runVals.length-1]} — ${collected.length} cartas`);
    }
  }

  const didCollect = collected.length > 0;

  // ── MESA VACÍA (4 pts, solo si no es última tanda) ──
  if (didCollect && room.tableCards.length === 0 && !room.isLastTanda) {
    const pts = 4;
    room.scores[playerIdx] += pts;
    addRoundLog(room, { event: 'Mesa vacía', player: player.name, pts, detail: caida ? '+caída' : '' });
    addLog(room, `🌟 ¡Mesa vacía! ${player.name} — +${pts} pts${caida ? ' (+ caída)' : ''}`);
    broadcast(room, { type: 'mesa_vacia', by: player.name, pts, plusCaida: caida });
  }

  if (didCollect) {
    player.collected.push(...collected);
    room.lastCollectorIdx = playerIdx;
  } else {
    room.tableCards.push(card);
  }

  room.lastPlayedCard = card;
  room.lastPlayedBy = playerIdx;
  room.currentTurn = (playerIdx + 1) % n;

  const handsEmpty = room.players.every(p => p.hand.length === 0);
  if (handsEmpty) {
    if (room.deck.length > 0) {
      room.lastPlayedCard = null; room.lastPlayedBy = -1;
      sendState(room);
      setTimeout(() => dealTanda(room), 800);
    } else {
      sendState(room);
      setTimeout(() => endRound(room), 600);
    }
  } else {
    sendState(room);
  }
}

// ─── END ROUND ────────────────────────────────────────────────────────────────
function endRound(room) {
  const n = room.players.length;

  if (room.tableCards.length > 0) {
    const lastIdx = room.lastCollectorIdx >= 0 ? room.lastCollectorIdx : room.lastPlayedBy;
    if (lastIdx >= 0) {
      room.players[lastIdx].collected.push(...room.tableCards);
      addLog(room, `📦 Cartas restantes → ${room.players[lastIdx].name}`);
    }
    room.tableCards = [];
  }

  const base = n === 3 ? 13 : 20;
  const totalCollected = room.players.map(p => p.collected.length);
  const scoresBefore = [...room.scores];

  addLog(room, `📊 Conteo (base ${base}):`);

  if (n === 4 && room.teamMode) {
    const teamCollected = [0, 1].map(t =>
      room.players.filter(p => p.team === t).reduce((s, p) => s + p.collected.length, 0)
    );
    [0, 1].forEach(t => {
      const extra = Math.max(0, teamCollected[t] - base);
      room.players.filter(p => p.team === t).forEach(p => { room.scores[room.players.indexOf(p)] += extra; });
      addLog(room, `  Equipo ${t + 1}: ${teamCollected[t]} cartas → +${extra} pts`);
      if (extra > 0) {
        const nm = room.players.filter(p => p.team === t).map(p => p.name).join(' & ');
        addRoundLog(room, { event: 'Cartas', player: nm, pts: extra, detail: `${teamCollected[t]} cartas` });
      }
    });
  } else {
    room.players.forEach((p, i) => {
      const extra = Math.max(0, totalCollected[i] - base);
      room.scores[i] += extra;
      addLog(room, `  ${p.name}: ${totalCollected[i]} cartas → +${extra} pts`);
      if (extra > 0) addRoundLog(room, { event: 'Cartas', player: p.name, pts: extra, detail: `${totalCollected[i]} cartas` });
    });
  }

  addLog(room, `🏆 Marcador: ${room.players.map((p, i) => `${p.name}: ${room.scores[i]}`).join(' | ')}`);

  const summary = {
    log: room.roundLog,
    players: room.players.map((p, i) => ({
      name: p.name, cards: totalCollected[i],
      scoreTotal: room.scores[i],
      scoreDelta: room.scores[i] - scoresBefore[i],
    })),
    scores: room.scores,
    base,
  };

  room.state = 'round_end';
  room.round++;
  room.dealer = (room.dealer + 1) % n;
  room.readyForNext = [];

  broadcast(room, { type: 'round_end', summary });
  sendState(room);
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
let playerCounter = 0;

wss.on('connection', (ws) => {
  const playerId = `p${++playerCounter}`;
  let playerRoom = null;
  let playerData = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'createRoom') {
      const code = Math.random().toString(36).substring(2, 6).toUpperCase();
      const maxP = [2, 3, 4].includes(msg.maxPlayers) ? msg.maxPlayers : 4;
      rooms[code] = createRoom(code, maxP);
      const room = rooms[code];
      const p = { id: playerId, ws, name: msg.name || 'Jugador', team: 0, hand: [], collected: [], canto: null };
      room.players.push(p);
      playerRoom = room; playerData = p;
      sendTo(p, { type: 'joined', roomCode: code, playerId });
      sendState(room);
      return;
    }

    if (msg.type === 'joinRoom') {
      const room = rooms[msg.code];
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala no encontrada' })); return; }
      if (room.players.length >= room.maxPlayers) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala llena' })); return; }
      if (room.state !== 'waiting') { ws.send(JSON.stringify({ type: 'error', msg: 'Partida en curso' })); return; }
      const p = { id: playerId, ws, name: msg.name || 'Jugador', team: room.players.length % 2, hand: [], collected: [], canto: null };
      room.players.push(p);
      playerRoom = room; playerData = p;
      sendTo(p, { type: 'joined', roomCode: room.code, playerId });
      addLog(room, `👤 ${p.name} se unió`);
      sendState(room);
      if (room.players.length === room.maxPlayers) {
        addLog(room, `✅ ¡Todos listos! Comenzando en 3s...`);
        setTimeout(() => startGame(room), 3000);
      }
      return;
    }

    if (!playerRoom || !playerData) return;

    if (msg.type === 'puestoChoice') {
      if (playerRoom.state !== 'puesto_choosing') return;
      if (playerRoom.players.indexOf(playerData) !== playerRoom.dealer) {
        sendTo(playerData, { type: 'error', msg: 'Solo el repartidor elige' }); return;
      }
      startPuesto(playerRoom, msg.direction === 'asc' ? 'asc' : 'desc');
      return;
    }

    if (msg.type === 'playCard') {
      if (playerRoom.state !== 'playing') return;
      const pidx = playerRoom.players.indexOf(playerData);
      if (pidx !== playerRoom.currentTurn) { sendTo(playerData, { type: 'error', msg: 'No es tu turno' }); return; }
      if (msg.cardIndex < 0 || msg.cardIndex >= playerData.hand.length) return;
      playCard(playerRoom, pidx, msg.cardIndex);
      return;
    }

    if (msg.type === 'nextRound') {
      if (playerRoom.state !== 'round_end') return;
      if (!playerRoom.readyForNext.includes(playerId)) {
        playerRoom.readyForNext.push(playerId);
        broadcast(playerRoom, { type: 'ready_count', count: playerRoom.readyForNext.length, total: playerRoom.players.length });
        addLog(playerRoom, `✅ ${playerData.name} listo (${playerRoom.readyForNext.length}/${playerRoom.players.length})`);
      }
      if (playerRoom.readyForNext.length >= playerRoom.players.length) {
        playerRoom.readyForNext = [];
        dealRound(playerRoom);
      }
      return;
    }

    if (msg.type === 'chat') {
      broadcast(playerRoom, { type: 'chat', from: playerData.name, msg: msg.text });
      return;
    }
  });

  ws.on('close', () => {
    if (playerRoom && playerData) {
      broadcast(playerRoom, { type: 'log', msg: `⚠️ ${playerData.name} se desconectó` });
      playerRoom.players = playerRoom.players.filter(p => p.id !== playerId);
      if (playerRoom.players.length === 0) delete rooms[playerRoom.code];
      else sendState(playerRoom);
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🃏 Caída Server — puerto ${PORT}\n`);
});
