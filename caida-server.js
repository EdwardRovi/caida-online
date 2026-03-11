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
const VALUES = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12]; // baraja española 40 cartas

function makeCard(suit, val) {
  const display = val === 10 ? '10-Sota' : val === 11 ? '11-Caballo' : val === 12 ? '12-Rey' : String(val);
  return { suit, val, display };
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const val of VALUES)
      deck.push(makeCard(suit, val));
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── CARD HELPERS ─────────────────────────────────────────────────────────────

// Is val a "figure" (Sota/Caballo/Rey)?
function isFigure(val) { return val >= 10; }

// Points for a caída (falling on card played by previous player)
function caídaPoints(val) {
  if (val <= 7) return 1;
  if (val === 10) return 2;
  if (val === 11) return 3;
  if (val === 12) return 4;
  return 1;
}

// Check if array of vals are consecutive (escalera)
function areConsecutive(vals) {
  if (vals.length < 2) return false;
  const sorted = [...vals].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i-1] + 1) return false;
  }
  return true;
}

// Analyze cantos for a hand of 3 cards
function analyzeCantos(hand) {
  const vals = hand.map(c => c.val);
  const counts = {};
  vals.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const countVals = Object.values(counts).sort((a, b) => b - a);

  // Tibilín: 3 iguales — wins instantly
  if (countVals[0] === 3) {
    const v = parseInt(Object.keys(counts).find(k => counts[k] === 3));
    return { type: 'tibilin', rank: 100, pts: 0, val: v, desc: `Tibilín de ${v}` };
  }

  // Vigía: 2 iguales + 1 consecutiva a ellas
  if (countVals[0] === 2) {
    const pairVal = parseInt(Object.keys(counts).find(k => counts[k] === 2));
    const singleVal = parseInt(Object.keys(counts).find(k => counts[k] === 1));
    if (Math.abs(pairVal - singleVal) === 1) {
      const pts = 7;
      return { type: 'vigia', rank: 3, pts, val: pairVal, desc: `Vigía de ${pairVal}` };
    }
    // Ronda: 2 iguales, no consecutiva
    const pts = isFigure(pairVal) ? caídaPoints(pairVal) : 1;
    return { type: 'ronda', rank: 2, pts, val: pairVal, desc: `Ronda de ${pairVal}` };
  }

  // Patrulla: 3 consecutivas
  if (areConsecutive(vals)) {
    return { type: 'patrulla', rank: 4, pts: 6, val: Math.max(...vals), desc: `Patrulla ${Math.min(...vals)}-${Math.max(...vals)}` };
  }

  return null; // no canto
}

// Compare two cantos — returns >0 if a beats b
function compareCantos(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  // Same type: compare val (higher is better for figures, same logic)
  return a.val - b.val;
}

// ─── ROOMS ────────────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(code, maxPlayers) {
  maxPlayers = [2, 3, 4].includes(maxPlayers) ? maxPlayers : 4;
  return {
    code,
    maxPlayers,
    players: [],       // { id, ws, name, team, hand, collected, cantos }
    state: 'waiting',
    deck: [],
    tableCards: [],    // 4 face-up cards on table
    round: 0,
    dealer: 0,
    currentTurn: 0,
    lastPlayedCard: null,   // { card, playerIdx } — for caída detection
    lastPlayedBy: -1,
    scores: [],        // per player (or per team in 2v2)
    teamMode: false,
    cantosDone: false,  // whether cantos phase is resolved
    cantoResults: [],   // resolved cantos for display
    log: [],
    puestoResult: null, // result of initial 4-card deal
    gameOver: false,
    roundsPlayed: 0,
  };
}

function broadcast(room, msg) {
  room.players.forEach(p => {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  });
}

function sendTo(player, msg) {
  if (player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
}

function addLog(room, msg) {
  room.log.push(msg);
  broadcast(room, { type: 'log', msg });
}

// ─── BUILD STATE ──────────────────────────────────────────────────────────────
function buildStateFor(room, player) {
  const myIdx = room.players.indexOf(player);
  return {
    roomCode: room.code,
    maxPlayers: room.maxPlayers,
    gameState: room.state,
    teamMode: room.teamMode,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      cardCount: p.hand ? p.hand.length : 0,
      collectedCount: p.collected ? p.collected.length : 0,
      isYou: p.id === player.id,
      hand: p.id === player.id ? p.hand : null,
      canto: p.canto || null,
      cantoDeclared: p.cantoDeclared || false,
    })),
    tableCards: room.tableCards,
    scores: room.scores,
    currentTurn: room.currentTurn,
    dealer: room.dealer,
    lastPlayedCard: room.lastPlayedCard,
    lastPlayedBy: room.lastPlayedBy,
    myIdx,
    cantosDone: room.cantosDone,
    cantoResults: room.cantoResults || [],
    puestoResult: room.puestoResult,
    round: room.round,
    cardsInDeck: room.deck.length,
    gameOver: room.gameOver,
  };
}

function sendState(room) {
  room.players.forEach(p => sendTo(p, { type: 'state', state: buildStateFor(room, p) }));
}

// ─── GAME START ───────────────────────────────────────────────────────────────
function startGame(room) {
  const n = room.players.length;
  room.teamMode = n === 4;
  // Assign teams for 4p: seats 0,2 = team 0; seats 1,3 = team 1
  room.players.forEach((p, i) => {
    p.team = room.teamMode ? i % 2 : i; // in non-team modes each player is their own "team"
    p.collected = [];
    p.canto = null;
    p.cantoDeclared = false;
  });
  room.scores = room.players.map(() => 0);
  room.round = 0;
  room.dealer = 0;
  addLog(room, `🎮 ¡Comienza la Caída! ${n} jugadores`);
  dealRound(room);
}

// ─── DEAL ROUND ───────────────────────────────────────────────────────────────
function dealRound(room) {
  const n = room.players.length;
  room.deck = shuffle(makeDeck());
  room.tableCards = [];
  room.lastPlayedCard = null;
  room.lastPlayedBy = -1;
  room.cantosDone = false;
  room.cantoResults = [];
  room.puestoResult = null;
  room.players.forEach(p => {
    p.hand = [];
    p.collected = [];
    p.canto = null;
    p.cantoDeclared = false;
  });

  // Put 4 face-up cards on table
  room.tableCards = room.deck.splice(0, 4);

  // Check "puesto" — table cards sum to 10 or are all consecutive
  const tableVals = room.tableCards.map(c => c.val);
  const tableSum = tableVals.reduce((a, b) => a + b, 0);
  const tableConsec = areConsecutive(tableVals);
  if (tableSum === 10 || tableConsec) {
    const reason = tableSum === 10 ? `suman 10 (${tableSum})` : `son consecutivas`;
    room.puestoResult = { dealer: room.players[room.dealer].name, reason };
    // Dealer scores 1 point for puesto
    room.scores[room.dealer] += 1;
    addLog(room, `🎯 ¡PUESTO! Las 4 cartas de la mesa ${reason} — +1 para ${room.players[room.dealer].name}`);
  }

  // Deal 3 cards to each player
  room.players.forEach(p => { p.hand = room.deck.splice(0, 3); });

  // Analyze cantos
  room.players.forEach(p => { p.canto = analyzeCantos(p.hand); });

  room.state = 'cantos';
  room.currentTurn = (room.dealer + 1) % n;
  addLog(room, `🃏 Reparto ${room.round + 1}. Repartidor: ${room.players[room.dealer].name}`);

  sendState(room);
  resolveCantos(room);
}

// ─── CANTOS RESOLUTION ────────────────────────────────────────────────────────
function resolveCantos(room) {
  const players = room.players;
  const n = players.length;
  const manoIdx = (room.dealer + 1) % n;

  const withCanto = players.map((p, i) => ({ p, i, canto: p.canto })).filter(x => x.canto);

  if (withCanto.length === 0) {
    room.cantosDone = true;
    room.cantoResults = [];
    room.state = 'playing';
    addLog(room, '▶️ Sin cantos — ¡a jugar!');
    sendState(room);
    return;
  }

  // Check for tibilín
  const tibilin = withCanto.find(x => x.canto.type === 'tibilin');
  if (tibilin) {
    // If multiple tibilines, mano wins
    const tibilines = withCanto.filter(x => x.canto.type === 'tibilin');
    let winner;
    if (tibilines.length === 1) {
      winner = tibilines[0];
    } else {
      // mano priority
      winner = tibilines.reduce((best, cur) => {
        const distBest = (best.i - manoIdx + n) % n;
        const distCur  = (cur.i  - manoIdx + n) % n;
        return distCur < distBest ? cur : best;
      });
    }
    addLog(room, `🃏 ¡TIBILÍN! ${winner.p.name} tiene tres ${winner.canto.val} — ¡gana la ronda automáticamente!`);
    room.scores[winner.i] += 10; // Tibilín wins the round
    room.cantoResults = [{ player: winner.p.name, canto: winner.canto.desc, pts: 10, won: true }];
    room.cantosDone = true;
    endRound(room);
    return;
  }

  // Find best canto among all players
  let bestCanto = null;
  withCanto.forEach(x => {
    if (compareCantos(x.canto, bestCanto) > 0) bestCanto = x.canto;
  });

  // Among those with the best canto, mano wins ties
  const topCantos = withCanto.filter(x => compareCantos(x.canto, bestCanto) === 0);
  const winner = topCantos.reduce((best, cur) => {
    const distBest = (best.i - manoIdx + n) % n;
    const distCur  = (cur.i  - manoIdx + n) % n;
    return distCur < distBest ? cur : best;
  });

  // Winner's canto kills lower cantos — winner scores all canto points including beaten ones
  let totalPts = winner.canto.pts;
  const results = [];

  withCanto.forEach(x => {
    if (x.i === winner.i) {
      results.push({ player: x.p.name, canto: x.canto.desc, pts: x.canto.pts, won: true });
    } else {
      // Beaten canto: winner absorbs its points
      totalPts += x.canto.pts;
      results.push({ player: x.p.name, canto: x.canto.desc, pts: x.canto.pts, won: false, killedBy: winner.p.name });
    }
  });

  room.scores[winner.i] += totalPts;
  addLog(room, `🎺 Cantos: ${winner.p.name} gana con ${winner.canto.desc} — +${totalPts} puntos`);
  withCanto.filter(x => x.i !== winner.i).forEach(x => {
    addLog(room, `  ↳ Mata el ${x.canto.desc} de ${x.p.name}`);
  });

  room.cantoResults = results;
  room.cantosDone = true;
  room.state = 'playing';
  sendState(room);
}

// ─── PLAY A CARD ──────────────────────────────────────────────────────────────
function playCard(room, playerIdx, cardIndex) {
  const player = room.players[playerIdx];
  const card = player.hand[cardIndex];
  if (!card) return;

  const n = room.players.length;

  // Remove card from hand
  player.hand.splice(cardIndex, 1);

  addLog(room, `🃏 ${player.name} juega ${card.display} de ${card.suit}`);

  // ── Check for CAÍDA ──
  let caida = false;
  if (room.lastPlayedBy !== -1 && room.lastPlayedCard) {
    if (room.lastPlayedCard.val === card.val) {
      // Caída! Player "falls" on the previous player's card
      const pts = caídaPoints(card.val);
      room.scores[playerIdx] += pts;
      caida = true;
      addLog(room, `💥 ¡CAÍDA! ${player.name} le cae a ${room.players[room.lastPlayedBy].name} con ${card.display} — +${pts} punto(s)`);
      broadcast(room, { type: 'caida', by: player.name, on: room.players[room.lastPlayedBy].name, card: card, pts });
    }
  }

  // ── Try to collect from table ──
  let collected = [];

  // Same number on table
  const sameOnTable = room.tableCards.filter(c => c.val === card.val);
  if (sameOnTable.length > 0) {
    collected = [...sameOnTable];
    room.tableCards = room.tableCards.filter(c => c.val !== card.val);
    collected.push(card); // also take the played card
    addLog(room, `✅ ${player.name} limpia ${collected.length - 1} carta(s) de la mesa con ${card.display}`);
  } else {
    // Check for escalera: if table has consecutive cards including the played one
    // Try to find a run on the table that starts with (or includes going up from) the played card
    // Rule: if table has cards x, x+1, x+2 and you play x → take all from x upward
    const tableVals = room.tableCards.map(c => c.val).sort((a, b) => a - b);
    const playedVal = card.val;

    // Find consecutive sequence on table starting at or below playedVal
    // Player throws card val V: look for runs starting at V going up
    let runStart = playedVal;
    while (room.tableCards.some(c => c.val === runStart - 1)) runStart--;
    // Build the full consecutive chain from runStart that includes playedVal
    let runVals = [];
    let v = runStart;
    while (room.tableCards.some(c => c.val === v) || v === playedVal) {
      runVals.push(v);
      v++;
      if (v > 12) break;
      if (!room.tableCards.some(c => c.val === v) && v !== playedVal) break;
    }
    // Only collect if the played card is part of a multi-card run on the table
    const tableRunVals = runVals.filter(x => x !== playedVal);
    if (tableRunVals.length >= 2 && runVals.includes(playedVal)) {
      // Take all cards of those values from table
      tableRunVals.forEach(rv => {
        const found = room.tableCards.find(c => c.val === rv);
        if (found) {
          collected.push(found);
          room.tableCards = room.tableCards.filter(c => c !== found);
        }
      });
      collected.push(card);
      addLog(room, `🎯 ${player.name} recoge escalera con ${card.display} — ${collected.length} cartas`);
    }
  }

  if (collected.length > 0) {
    player.collected.push(...collected);
  } else {
    // Card goes to table (not collected)
    room.tableCards.push(card);
  }

  // Update last played (for caída detection)
  room.lastPlayedCard = card;
  room.lastPlayedBy = playerIdx;

  // Advance turn
  room.currentTurn = (playerIdx + 1) % n;

  // Check if all hands empty → deal again or end
  const handsEmpty = room.players.every(p => p.hand.length === 0);
  if (handsEmpty) {
    if (room.deck.length >= n * 3) {
      // Deal more cards (3 per player, no new table cards)
      room.players.forEach(p => { p.hand = room.deck.splice(0, 3); });
      // In 3-player mode: if 1 card left after dealing, give it to dealer
      if (room.deck.length === 1 && n === 3) {
        room.players[room.dealer].hand.push(room.deck.pop());
        addLog(room, `🃏 Carta sobrante al repartidor`);
      }
      addLog(room, `🃏 Nueva mano repartida`);
      sendState(room);
    } else {
      // Remaining deck cards (< n*3) — deal what's left then end
      if (room.deck.length > 0) {
        // Distribute remaining cards evenly
        let di = (room.dealer + 1) % n;
        while (room.deck.length > 0) {
          room.players[di].hand.push(room.deck.pop());
          di = (di + 1) % n;
        }
      }
      if (room.players.every(p => p.hand.length === 0)) {
        endRound(room);
        return;
      }
      sendState(room);
    }
  } else {
    sendState(room);
  }
}

// ─── END ROUND ────────────────────────────────────────────────────────────────
function endRound(room) {
  const n = room.players.length;

  // Remaining table cards go to last player who collected
  if (room.tableCards.length > 0) {
    // Find last player who took cards
    let lastCollector = -1;
    let lastCollected = -1;
    // Use lastPlayedBy as proxy for last collector (simplified)
    // Actually: give remaining table to whoever last collected (tracking lastPlayedBy)
    // In real game: last person to take cards takes remaining table
    // We'll store this in lastCollectorIdx
    const lastIdx = room.lastCollectorIdx !== undefined ? room.lastCollectorIdx : room.lastPlayedBy;
    if (lastIdx >= 0) {
      room.players[lastIdx].collected.push(...room.tableCards);
      addLog(room, `📦 Cartas restantes de la mesa van a ${room.players[lastIdx].name}`);
    }
    room.tableCards = [];
  }

  // Count cards for scoring
  const totalCollected = room.players.map(p => p.collected.length);
  const base = n === 3 ? 13 : 20;

  addLog(room, `📊 Conteo final (base ${base}):`);

  if (n === 4 && room.teamMode) {
    // Team mode: add team collections
    const teamCollected = [0, 1].map(team =>
      room.players.filter(p => p.team === team).reduce((s, p) => s + p.collected.length, 0)
    );
    [0, 1].forEach(team => {
      const extra = Math.max(0, teamCollected[team] - base);
      if (extra > 0) {
        room.players.filter(p => p.team === team).forEach(p => { room.scores[room.players.indexOf(p)] += extra; });
        addLog(room, `  Equipo ${team + 1}: ${teamCollected[team]} cartas → +${extra} puntos`);
      } else {
        addLog(room, `  Equipo ${team + 1}: ${teamCollected[team]} cartas → +0 puntos`);
      }
    });
  } else {
    room.players.forEach((p, i) => {
      const extra = Math.max(0, totalCollected[i] - base);
      room.scores[i] += extra;
      addLog(room, `  ${p.name}: ${totalCollected[i]} cartas → +${extra} puntos`);
    });
  }

  addLog(room, `🏆 Puntuación: ${room.players.map((p, i) => `${p.name}: ${room.scores[i]}`).join(' | ')}`);

  const roundSummary = {
    collected: room.players.map((p, i) => ({ name: p.name, cards: totalCollected[i], pts: room.scores[i] })),
    scores: room.scores,
    base,
  };

  room.state = 'round_end';
  room.round++;
  room.dealer = (room.dealer + 1) % n;

  broadcast(room, { type: 'round_end', summary: roundSummary, scores: room.scores });
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
      const p = { id: playerId, ws, name: msg.name || 'Jugador', team: 0, hand: [], collected: [], canto: null, cantoDeclared: false };
      room.players.push(p);
      playerRoom = room;
      playerData = p;
      sendTo(p, { type: 'joined', roomCode: code, playerId });
      sendState(room);
      return;
    }

    if (msg.type === 'joinRoom') {
      const room = rooms[msg.code];
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala no encontrada' })); return; }
      if (room.players.length >= room.maxPlayers) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala llena' })); return; }
      if (room.state !== 'waiting') { ws.send(JSON.stringify({ type: 'error', msg: 'Partida en curso' })); return; }

      const seatIdx = room.players.length;
      const team = seatIdx % 2;
      const p = { id: playerId, ws, name: msg.name || 'Jugador', team, hand: [], collected: [], canto: null, cantoDeclared: false };
      room.players.push(p);
      playerRoom = room;
      playerData = p;
      sendTo(p, { type: 'joined', roomCode: room.code, playerId });
      addLog(room, `👤 ${p.name} se unió`);
      sendState(room);

      if (room.players.length === room.maxPlayers) {
        addLog(room, `✅ ¡${room.maxPlayers} jugadores! La partida comenzará en 3 segundos...`);
        setTimeout(() => startGame(room), 3000);
      }
      return;
    }

    if (!playerRoom || !playerData) return;

    if (msg.type === 'playCard') {
      if (playerRoom.state !== 'playing') return;
      const pidx = playerRoom.players.indexOf(playerData);
      if (pidx !== playerRoom.currentTurn) {
        sendTo(playerData, { type: 'error', msg: 'No es tu turno' });
        return;
      }
      if (msg.cardIndex < 0 || msg.cardIndex >= playerData.hand.length) return;
      playCard(playerRoom, pidx, msg.cardIndex);
      return;
    }

    if (msg.type === 'nextRound') {
      if (playerRoom.state !== 'round_end') return;
      if (!playerRoom.readyForNext) playerRoom.readyForNext = [];
      if (!playerRoom.readyForNext.includes(playerId)) {
        playerRoom.readyForNext.push(playerId);
        broadcast(playerRoom, { type: 'log', msg: `✅ ${playerData.name} listo (${playerRoom.readyForNext.length}/${playerRoom.players.length})` });
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

// ─── START ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🃏 Caída Server en puerto ${PORT}\n`);
});
