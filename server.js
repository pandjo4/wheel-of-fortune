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
const LETTERS = "ABCČĆDĐEFGHIJKLMNOPQRSŠTUVWZŽ";
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
const PUZZLES = Object.entries(PHRASES).flatMap(([cat, list]) => list.map(t => [cat, t]));

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
    hostId: room.hostId, currentPlayerId: room.currentPlayerId, round: room.round,
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
  if (!room.players.length) return;
  const idx = room.players.findIndex(p => p.id === room.currentPlayerId);
  room.currentPlayerId = room.players[(idx + 1 + room.players.length) % room.players.length].id;
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
  room.message = "Zavrtite kolo i pokušajte pogoditi slovo.";
  room.status = "playing";
  room.round += 1;
}
function startGame(room) {
  room.status = "playing"; room.round = 0; room.usedPuzzles = new Set();
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
  emitRoom(room);
}
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do { code = Array.from({length: 5}, () => chars[Math.floor(Math.random()*chars.length)]).join(""); } while (rooms.has(code));
  return code;
}
io.on("connection", socket => {
  socket.emit("config", { wheel: WHEEL, spinMs: SPIN_MS });
  socket.on("createRoom", ({ name, maxPlayers }) => {
    maxPlayers = Number(maxPlayers);
    if (![2,3].includes(maxPlayers)) return sendError(socket, "Možeš izabrati tačno 2 ili 3 igrača.");
    const code = makeCode();
    const room = { code, status: "lobby", maxPlayers, players: [], hostId: socket.id, currentPlayerId: null, round: 0, puzzle: null, revealed: new Set(), guessed: new Set(), usedPuzzles: new Set(), wheelResult: null, lastWheelValue: 0, doubleNext: false, message: "Čeka se da se igrači pridruže.", lastAction: null, winnerId: null, finalScores: null };
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
  socket.on("spin", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== "playing" || room.spinning || room.currentPlayerId !== socket.id) return sendError(socket, "Nije tvoj potez.");
    if (room.wheelResult) return sendError(socket, "Prvo odaberi slovo.");
    const index = Math.floor(Math.random() * WHEEL.length);
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
    room.wheelResult = null;
    room.doubleNext = false;
    room.message = `${player(room, socket.id)?.name || "Igrač"} je preskočio/la potez.`;
    room.lastAction = { type: "pass" };
    nextTurn(room);
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
    p.score -= 250; room.guessed.add(letter);
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
    if (room.round >= 5) {
      room.status = "gameOver";
      room.finalScores = [...room.players].sort((a,b) => b.score-a.score).map(p => ({ id:p.id, name:p.name, score:p.score }));
      room.message = room.finalScores[0].score === room.finalScores[room.finalScores.length-1].score ? "Neriješeno!" : `${room.finalScores[0].name} je ukupni pobjednik!`;
    } else {
      nextTurn(room); choosePuzzle(room);
    }
    emitRoom(room);
  });
  socket.on("disconnect", () => {
    const code = socket.data.roomCode, room = code && rooms.get(code);
    if (!room) return;
    const p = player(room, socket.id);
    if (p) p.connected = false;
    room.message = `${p ? p.name : "Igrač"} se odspojio/la. Ako se vrati istim putem, može ponovo ući u sobu.`;
    emitRoom(room);
    if (room.players.every(x => !x.connected)) setTimeout(() => { if (rooms.get(code) === room && room.players.every(x => !x.connected)) rooms.delete(code); }, 30*60*1000);
  });
});
server.listen(PORT, () => console.log(`Wheel of Fortune running on port ${PORT}`));
