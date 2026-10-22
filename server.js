const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");
const PHRASES = require("./phrases");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.json({ ok: true, game: "Wheel of Fortune" }));

const PORT = process.env.PORT || 3000;
const rooms = new Map();
// Bosanska abeceda (bez Q, W, X, Y). DŽ, LJ i NJ se biraju kao dva slova (D+Ž, L+J, N+J).
const LETTERS = "ABCČĆDĐEFGHIJKLMNOPRSŠTUVZŽ";
const ROUND_OPTIONS = [1, 3, 5];
const DEFAULT_ROUNDS = 5;
const MAX_PASS_STREAK = 3; // toliko dobrovoljnih preskakanja zaredom završava rundu bez pobjednika
const VOWELS = new Set(["A","E","I","O","U"]);
const SPIN_MS = 4200;
const WHEEL = [
  { label: "100", value: 100, color: "#f6c453" },
  { label: "250", value: 250, color: "#29c4b7" },
  { label: "BANKROT", action: "bankrupt", color: "#14111f", text: "#ff4d6d" },
  { label: "150", value: 150, color: "#7c6cf2", text: "#fff" },
  { label: "300", value: 300, color: "#38a3ff" },
  { label: "GUBI POTEZ", action: "lose", color: "#ff8a4c" },
  { label: "200", value: 200, color: "#f6c453" },
  { label: "400", value: 400, color: "#29c4b7" },
  { label: "500", value: 500, color: "#ef476f", text: "#fff" },
  { label: "100", value: 100, color: "#38a3ff" },
  { label: "DUPLO", action: "double", color: "#8b5cf6", text: "#fff" },
  { label: "350", value: 350, color: "#ff8a4c" }
];
// Fraze se nalaze u phrases.js
// Fraze sa slovima van bosanske abecede (npr. Q, W, X, Y) ili sa posebnim znakovima se preskaču,
// jer ih igrači ne bi mogli otkriti preko tastature.
const ALLOWED_CHARS = new Set([...LETTERS, " ", "-"]);
const PUZZLES = Object.entries(PHRASES)
  .flatMap(([cat, list]) => list.map(t => [cat, t]))
  .filter(([cat, t]) => {
    const ok = [...normalize(t)].every(ch => ALLOWED_CHARS.has(ch));
    if (!ok) console.warn(`[phrases] Preskočena fraza (nedozvoljeno slovo/znak): "${t}" (${cat})`);
    return ok;
  });

function cleanName(s) {
  return String(s || "").trim().replace(/\s+/g, " ").slice(0, 18);
}
function normalize(s) {
  return String(s || "").toLocaleUpperCase("bs-BA").normalize("NFC").replace(/Đ/g, "Đ");
}
function publicRoom(room) {
  return {
    code: room.code, status: room.status, maxPlayers: room.maxPlayers,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, connected: p.connected })),
    hostId: room.hostId, currentPlayerId: room.currentPlayerId, round: room.round, totalRounds: room.totalRounds,
    passStreak: room.passStreak, maxPassStreak: MAX_PASS_STREAK,
    category: room.puzzle ? room.puzzle.category : null,
    masked: room.puzzle ? [...room.puzzle.answer].map(ch => (ch === " " || ch === "-" || room.revealed.has(ch)) ? ch : "_") : [],
    guessed: room.puzzle ? [...room.guessed].sort() : [],
    wheelResult: room.wheelResult, spinning: !!room.spinning, wheelIndex: room.wheelIndex ?? null, message: room.message, lastAction: room.lastAction,
    winnerId: room.winnerId, finalScores: room.finalScores || null,
    canBuyVowel: !!room.puzzle && room.players.find(p => p.id === room.currentPlayerId)?.score >= 250
  };
}
let actionSeq = 0;
function emitRoom(room) { if (room.lastAction && !room.lastAction.id) room.lastAction.id = ++actionSeq; io.to(room.code).emit("state", publicRoom(room)); }
function sendError(socket, message) { socket.emit("toast", { message }); }
function player(room, id) { return room.players.find(p => p.id === id); }
function nextTurn(room) {
  const n = room.players.length;
  if (!n) return;
  const idx = room.players.findIndex(p => p.id === room.currentPlayerId);
  let next = null;
  for (let i = 1; i <= n; i++) {
    const cand = room.players[(idx + i + n) % n];
    if (cand.connected) { next = cand; break; }
  }
  room.currentPlayerId = (next || room.players[(idx + 1 + n) % n]).id;
  room.wheelResult = null;
  room.doubleNext = false;
}
function choosePuzzle(room) {
  let choices = PUZZLES.filter(p => !room.usedPuzzles.has(p[1]));
  if (!choices.length) { room.usedPuzzles.clear(); choices = PUZZLES; }
  const chosen = choices[Math.floor(Math.random() * choices.length)];
  room.usedPuzzles.add(chosen[1]);
  room.puzzle = { category: chosen[0], answer: normalize(chosen[1]) };
  room.revealed = new Set();
  room.guessed = new Set();
  room.wheelResult = null;
  room.doubleNext = false;
  room.passStreak = 0;
  room.winnerId = null;
  room.lastAction = null;
  room.message = "Zavrtite kolo i pokušajte pogoditi slovo.";
  room.status = "playing";
  room.round += 1;
}
function startGame(room) {
  room.status = "playing"; room.round = 0;
  room.winnerId = null; room.finalScores = null; room.passStreak = 0;
  room.players.forEach(p => p.score = 0);
  room.currentPlayerId = room.hostId;
  choosePuzzle(room);
}
function finishRound(room, winnerId) {
  room.status = "roundOver"; room.winnerId = winnerId;
  room.message = winnerId ? `${player(room, winnerId)?.name || "Igrač"} je riješio/la frazu!` : "Runda je završena.";
  room.lastAction = { type: "reveal", answer: room.puzzle.answer };
}
function allRevealed(room) {
  return [...room.puzzle.answer].every(ch => ch === " " || ch === "-" || room.revealed.has(ch));
}
function resolveGuess(room, socket, letter) {
  const p = player(room, socket.id);
  if (!p || room.status !== "playing" || room.spinning || room.currentPlayerId !== socket.id || !room.wheelResult) return sendError(socket, "Prvo zavrti kolo pa odaberi slovo.");
  letter = normalize(letter);
  if (!LETTERS.includes(letter) || letter.length !== 1) return sendError(socket, "Odaberi važeće slovo.");
  if (room.guessed.has(letter)) return sendError(socket, "To slovo je već pokušano.");
  if (VOWELS.has(letter)) return sendError(socket, "Samoglasnik možeš kupiti za 250 bodova.");
  room.guessed.add(letter);
  room.passStreak = 0;
  const count = [...room.puzzle.answer].filter(ch => ch === letter).length;
  room.wheelResult = null;
  if (count) {
    const multiplier = room.doubleNext ? 2 : 1;
    p.score += count * room.lastWheelValue * multiplier;
    room.doubleNext = false;
    room.revealed.add(letter);
    room.message = `Odlično! Slovo ${letter} pojavljuje se ${count} ${count === 1 ? "put" : "puta"}. +${count * room.lastWheelValue * multiplier} bodova.`;
    room.lastAction = { type: "correct", letter, count, points: count * room.lastWheelValue * multiplier };
    if (allRevealed(room)) finishRound(room, p.id);
  } else {
    room.message = `Slovo ${letter} nije u frazi.`;
    room.lastAction = { type: "wrong", letter };
    nextTurn(room);
  }
  emitRoom(room);
}
function finishSpin(room, pid, index) {
  if (rooms.get(room.code) !== room || !room.spinning) return;
  room.spinning = false;
  const p = player(room, pid), item = WHEEL[index];
  room.lastWheelValue = item.value || 0;
  if (item.action === "bankrupt" || item.action === "lose") {
    if (item.action === "bankrupt") p.score = 0;
    nextTurn(room);
    const nextName = player(room, room.currentPlayerId)?.name;
    room.message = item.action === "bankrupt" ? `BANKROT! ${p.name} gubi sve bodove. Na potezu: ${nextName}.` : `GUBI POTEZ! ${p.name} preskače red. Na potezu: ${nextName}.`;
    room.lastAction = { type: item.action, playerName: p.name, nextName };
  } else if (item.action === "double") {
    room.wheelResult = item; room.doubleNext = true; room.lastWheelValue = 200;
    room.message = "DUPLO! Sljedeće tačno slovo vrijedi duplo (400 po slovu).";
    room.lastAction = { type: "double", playerName: p.name };
  } else {
    room.wheelResult = item;
    room.message = `Kolo je stalo na ${item.label}. Odaberi suglasnik.`;
    room.lastAction = { type: "spinValue", value: item.value };
  }
  if (p && !p.connected && room.status === "playing" && room.currentPlayerId === p.id && room.players.some(x => x.connected)) {
    nextTurn(room);
    room.message += ` ${p.name} je odspojen/a. Na potezu: ${player(room, room.currentPlayerId)?.name}.`;
  }
  emitRoom(room);
}
function resetToLobby(room) {
  room.players = room.players.filter(p => p.connected);
  room.maxPlayers = Math.min(3, Math.max(2, room.players.length));
  room.players.forEach(p => p.score = 0);
  if (!room.players.some(p => p.id === room.hostId) && room.players[0]) room.hostId = room.players[0].id;
  Object.assign(room, {
    status: "lobby", round: 0, puzzle: null, revealed: new Set(), guessed: new Set(),
    wheelResult: null, wheelIndex: null, spinning: false, lastWheelValue: 0, doubleNext: false,
    currentPlayerId: null, lastAction: null, winnerId: null, finalScores: null, passStreak: 0,
    message: "Nazad u lobby. Domaćin može pokrenuti novu igru."
  });
}
// voluntary=true: igrač je sam napustio sobu; false: veza je pukla
function removeFromRoom(room, socketId, voluntary) {
  const p = player(room, socketId);
  if (!p) return;
  const code = room.code;
  const removable = room.status === "lobby" || (room.status === "gameOver" && voluntary);
  if (removable) room.players = room.players.filter(x => x.id !== socketId);
  else p.connected = false;

  if (!room.players.length) { rooms.delete(code); return; }

  let hostNote = "";
  if (room.hostId === socketId) {
    const nh = room.players.find(x => x.connected);
    if (nh) { room.hostId = nh.id; hostNote = ` ${nh.name} je sada domaćin.`; }
  }
  room.message = (removable ? `${p.name} je napustio/la sobu.` : `${p.name} se odspojio/la.`) + hostNote;
  if (room.status === "playing" && room.currentPlayerId === socketId && !room.spinning && room.players.some(x => x.connected)) {
    nextTurn(room);
    room.message += ` Na potezu: ${player(room, room.currentPlayerId)?.name}.`;
  }
  emitRoom(room);
  if (room.players.every(x => !x.connected)) {
    setTimeout(() => { if (rooms.get(code) === room && room.players.every(x => !x.connected)) rooms.delete(code); }, 30 * 60 * 1000);
  }
}
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do { code = Array.from({length: 5}, () => chars[Math.floor(Math.random()*chars.length)]).join(""); } while (rooms.has(code));
  return code;
}
io.on("connection", socket => {
  socket.emit("config", { wheel: WHEEL, spinMs: SPIN_MS });
  socket.on("createRoom", ({ name, maxPlayers, rounds }) => {
    maxPlayers = Number(maxPlayers);
    rounds = rounds === undefined ? DEFAULT_ROUNDS : Number(rounds);
    if (![2,3].includes(maxPlayers)) return sendError(socket, "Možeš izabrati tačno 2 ili 3 igrača.");
    if (!ROUND_OPTIONS.includes(rounds)) return sendError(socket, "Možeš izabrati 1, 3 ili 5 rundi.");
    const code = makeCode();
    const room = { code, status: "lobby", maxPlayers, totalRounds: rounds, passStreak: 0, players: [], hostId: socket.id, currentPlayerId: null, round: 0, puzzle: null, revealed: new Set(), guessed: new Set(), usedPuzzles: new Set(), wheelResult: null, lastWheelValue: 0, doubleNext: false, message: "Čeka se da se igrači pridruže.", lastAction: null, winnerId: null, finalScores: null };
    room.players.push({ id: socket.id, name: cleanName(name) || "Domaćin", score: 0, connected: true });
    rooms.set(code, room); socket.join(code); socket.data.roomCode = code;
    socket.emit("joined", { code, playerId: socket.id }); emitRoom(room);
  });
  socket.on("joinRoom", ({ code, name }) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return sendError(socket, "Soba nije pronađena. Provjeri kod.");
    if (room.status !== "lobby") return sendError(socket, "Igra je već počela.");
    if (room.players.length >= room.maxPlayers) return sendError(socket, "Soba je puna.");
    if (room.players.some(p => p.name.toLocaleLowerCase() === cleanName(name).toLocaleLowerCase())) return sendError(socket, "To ime je već zauzeto u sobi.");
    room.players.push({ id: socket.id, name: cleanName(name) || `Igrač ${room.players.length+1}`, score: 0, connected: true });
    socket.join(code); socket.data.roomCode = code;
    socket.emit("joined", { code, playerId: socket.id }); room.message = `${room.players[room.players.length-1].name} se pridružio/la.`; emitRoom(room);
  });
  socket.on("startGame", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostId) return sendError(socket, "Samo domaćin može pokrenuti igru.");
    if (room.players.length !== room.maxPlayers) return sendError(socket, `Potrebno je tačno ${room.maxPlayers} igrača.`);
    startGame(room); emitRoom(room);
  });
  socket.on("setRounds", ({ rounds }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostId || room.status !== "lobby") return sendError(socket, "Samo domaćin može mijenjati broj rundi.");
    rounds = Number(rounds);
    if (!ROUND_OPTIONS.includes(rounds)) return sendError(socket, "Možeš izabrati 1, 3 ili 5 rundi.");
    room.totalRounds = rounds;
    room.message = `Broj rundi: ${rounds}.`;
    emitRoom(room);
  });
  socket.on("spin", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== "playing" || room.spinning || room.currentPlayerId !== socket.id) return sendError(socket, "Nije tvoj potez.");
    if (room.wheelResult) return sendError(socket, "Prvo odaberi slovo.");
    const index = Math.floor(Math.random() * WHEEL.length);
    room.passStreak = 0;
    room.spinning = true; room.wheelIndex = index;
    room.message = `${player(room, socket.id).name} vrti kolo...`;
    io.to(room.code).emit("spinStart", { index, ms: SPIN_MS });
    emitRoom(room);
    setTimeout(() => finishSpin(room, socket.id, index), SPIN_MS + 150);
  });
  socket.on("guess", ({ letter }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    resolveGuess(room, socket, letter);
  });
  socket.on("passTurn", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== "playing" || room.spinning || room.currentPlayerId !== socket.id) return sendError(socket, "Nije tvoj potez.");
    const name = player(room, socket.id)?.name || "Igrač";
    room.wheelResult = null;
    room.doubleNext = false;
    room.passStreak += 1;
    if (room.passStreak >= MAX_PASS_STREAK) {
      // Tri dobrovoljna preskakanja zaredom: runda se završava, fraza se otkriva, niko ne dobija bodove.
      finishRound(room, null);
      room.message = `Preskočeno ${MAX_PASS_STREAK} puta zaredom. Runda se prelazi bez pobjednika.`;
      room.lastAction = { type: "skipRound", answer: room.puzzle.answer };
    } else {
      const left = MAX_PASS_STREAK - room.passStreak;
      room.message = `${name} je preskočio/la potez (${room.passStreak}/${MAX_PASS_STREAK} zaredom).` + (left === 1 ? " Još jedno preskakanje i runda se prelazi bez pobjednika!" : "");
      room.lastAction = { type: "pass", streak: room.passStreak };
      nextTurn(room);
    }
    emitRoom(room);
  });
  socket.on("buyVowel", ({ letter }) => {
    const room = rooms.get(socket.data.roomCode), p = room && player(room, socket.id);
    if (!room || !p || room.status !== "playing" || room.spinning || room.currentPlayerId !== socket.id) return sendError(socket, "Nije tvoj potez.");
    if (room.wheelResult) return sendError(socket, "Prvo završi potez na kolu.");
    if (p.score < 250) return sendError(socket, "Treba ti najmanje 250 bodova.");
    letter = normalize(letter);
    if (!VOWELS.has(letter)) return sendError(socket, "Odaberi samoglasnik.");
    if (room.guessed.has(letter)) return sendError(socket, "To slovo je već pokušano.");
    p.score -= 250; room.guessed.add(letter); room.passStreak = 0;
    const count = [...room.puzzle.answer].filter(ch => ch === letter).length;
    if (count) {
      room.revealed.add(letter); room.message = `Samoglasnik ${letter} je u frazi!`;
      room.lastAction = { type: "correct", letter, count, points: 0 };
      if (allRevealed(room)) finishRound(room, p.id);
    } else {
      room.message = `Samoglasnik ${letter} nije u frazi.`; room.lastAction = { type: "wrong", letter }; nextTurn(room);
    }
    emitRoom(room);
  });
  socket.on("solve", ({ answer }) => {
    const room = rooms.get(socket.data.roomCode), p = room && player(room, socket.id);
    if (!room || !p || room.status !== "playing" || room.spinning || room.currentPlayerId !== socket.id) return sendError(socket, "Nije tvoj potez.");
    room.passStreak = 0;
    if (normalize(answer).trim() === room.puzzle.answer) {
      p.score += 500;
      finishRound(room, p.id); room.message = `${p.name} je riješio/la frazu i osvaja 500 bonus bodova!`;
      room.lastAction = { type: "solve", answer: room.puzzle.answer, points: 500 };
    } else {
      room.message = "Nije tačno! Gubiš potez."; room.lastAction = { type: "solveWrong", playerName: p.name }; nextTurn(room);
    }
    emitRoom(room);
  });
  socket.on("nextRound", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== "roundOver" || socket.id !== room.hostId) return sendError(socket, "Samo domaćin može nastaviti.");
    if (room.round >= room.totalRounds) {
      room.status = "gameOver";
      room.finalScores = [...room.players].sort((a,b) => b.score-a.score).map(p => ({ id:p.id, name:p.name, score:p.score }));
      const top = room.finalScores[0].score;
      const winners = room.finalScores.filter(x => x.score === top);
      room.message = winners.length === room.finalScores.length ? "Neriješeno!"
        : winners.length > 1 ? `Neriješeno između: ${winners.map(x => x.name).join(" i ")}!`
        : `${winners[0].name} je ukupni pobjednik!`;
    } else {
      nextTurn(room); choosePuzzle(room);
    }
    emitRoom(room);
  });
  socket.on("backToLobby", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostId) return sendError(socket, "Samo domaćin može vratiti igrače u lobby.");
    if (room.status !== "gameOver") return;
    resetToLobby(room);
    emitRoom(room);
  });
  socket.on("leaveRoom", () => {
    const code = socket.data.roomCode, room = code && rooms.get(code);
    if (!room) return;
    if (room.status !== "lobby" && room.status !== "gameOver") return sendError(socket, "Sobu možeš napustiti u lobbyju ili kad se igra završi.");
    socket.leave(code);
    socket.data.roomCode = null;
    removeFromRoom(room, socket.id, true);
  });
  socket.on("disconnect", () => {
    const code = socket.data.roomCode, room = code && rooms.get(code);
    if (!room) return;
    removeFromRoom(room, socket.id, false);
  });
});
server.listen(PORT, () => console.log(`Wheel of Fortune running on port ${PORT}`));
