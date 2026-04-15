require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'pong-ultra-secret';

// ── RANKS ──────────────────────────────────────────────
const RANKS = [
  { name: 'Iron I',       min: 0    },
  { name: 'Iron II',      min: 100  },
  { name: 'Bronze I',     min: 200  },
  { name: 'Bronze II',    min: 300  },
  { name: 'Silver I',     min: 400  },
  { name: 'Silver II',    min: 500  },
  { name: 'Gold I',       min: 600  },
  { name: 'Gold II',      min: 700  },
  { name: 'Platinum I',   min: 800  },
  { name: 'Platinum II',  min: 900  },
  { name: 'Diamond I',    min: 1000 },
  { name: 'Diamond II',   min: 1100 },
  { name: 'Master I',     min: 1200 },
  { name: 'Master II',    min: 1350 },
  { name: 'Grandmaster I',min: 1500 },
  { name: 'Grandmaster II',min:1650 },
  { name: 'Challenger I', min: 1800 },
  { name: 'Challenger II',min: 1950 },
  { name: 'Challenger III',min:2100 },
  { name: 'Apex',         min: 2300 }
];

function getRank(elo) {
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (elo >= RANKS[i].min) return RANKS[i].name;
  }
  return RANKS[0].name;
}

function calcElo(winnerElo, loserElo) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  return Math.round(K * (1 - expected));
}

// ── AUTH ROUTES ────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Alle Felder ausfüllen.' });

  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase
    .from('users')
    .insert({ username, email, password_hash: hash })
    .select('id, username, elo, coins')
    .single();

  if (error) return res.status(400).json({ error: 'Nutzername oder E-Mail schon vergeben.' });

  // Startskin vergeben
  await supabase.from('user_skins').insert({ user_id: data.id, skin_id: 'default' });

  const token = jwt.sign({ id: data.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { ...data, rank: getRank(data.elo) } });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase
    .from('users').select('*').eq('email', email).single();

  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Falsche E-Mail oder Passwort.' });

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  const { password_hash, ...safe } = user;
  res.json({ token, user: { ...safe, rank: getRank(user.elo) } });
});

// ── AUTH MIDDLEWARE ────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token ungültig.' }); }
}

// ── PROFIL & RANGLISTE ────────────────────────────────
app.get('/me', auth, async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('id, username, elo, coins, wins, losses').eq('id', req.user.id).single();
  const { data: skins } = await supabase
    .from('user_skins').select('skin_id').eq('user_id', req.user.id);
  res.json({ ...user, rank: getRank(user.elo), skins: skins.map(s => s.skin_id) });
});

app.get('/leaderboard', async (req, res) => {
  const { data } = await supabase
    .from('users').select('username, elo, wins').order('elo', { ascending: false }).limit(20);
  res.json(data.map(u => ({ ...u, rank: getRank(u.elo) })));
});

// ── SHOP ──────────────────────────────────────────────
const SKINS = [
  { id: 'default',  name: 'Klassik',   price: 0     },
  { id: 'plasma',   name: 'Plasma',    price: 200   },
  { id: 'toxin',    name: 'Toxin',     price: 500   },
  { id: 'ruby',     name: 'Rubin',     price: 1000  },
  { id: 'gold',     name: 'Imperial',  price: 2500  },
  { id: 'void',     name: 'Abgrund',   price: 5000  },
  { id: 'rgb',      name: 'Rainbow',   price: 10000 },
  // Wand-Skins
  { id: 'wall_neon',  name: 'Neon Wall',    price: 800,  type: 'wall' },
  { id: 'wall_lava',  name: 'Lava Wall',    price: 1500, type: 'wall' },
  { id: 'wall_space', name: 'Space Wall',   price: 3000, type: 'wall' },
];

app.get('/shop', auth, async (req, res) => {
  const { data: owned } = await supabase
    .from('user_skins').select('skin_id').eq('user_id', req.user.id);
  const ownedIds = owned.map(s => s.skin_id);
  res.json(SKINS.map(s => ({ ...s, owned: ownedIds.includes(s.id) })));
});

app.post('/shop/buy', auth, async (req, res) => {
  const { skin_id } = req.body;
  const skin = SKINS.find(s => s.id === skin_id);
  if (!skin) return res.status(404).json({ error: 'Skin nicht gefunden.' });

  const { data: user } = await supabase
    .from('users').select('coins').eq('id', req.user.id).single();
  if (user.coins < skin.price)
    return res.status(400).json({ error: 'Nicht genug Münzen.' });

  const { error: dupErr } = await supabase
    .from('user_skins').insert({ user_id: req.user.id, skin_id });
  if (dupErr) return res.status(400).json({ error: 'Bereits gekauft.' });

  await supabase.from('users')
    .update({ coins: user.coins - skin.price }).eq('id', req.user.id);

  res.json({ success: true, coins: user.coins - skin.price });
});

// ── WEBSOCKET MATCHMAKING & SPIEL ─────────────────────
const queue = { ranked: [], unranked: [] };
const games = new Map(); // gameId -> game state

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth') {
      try {
        const payload = jwt.verify(msg.token, JWT_SECRET);
        const { data: user } = await supabase
          .from('users').select('id, username, elo').eq('id', payload.id).single();
        ws.userId = user.id;
        ws.username = user.username;
        ws.elo = user.elo;
        ws.send(JSON.stringify({ type: 'auth_ok', user: { ...user, rank: getRank(user.elo) } }));
      } catch { ws.send(JSON.stringify({ type: 'auth_fail' })); }
    }

    if (msg.type === 'join_queue') {
      if (!ws.userId) return;
      ws.queueType = msg.ranked ? 'ranked' : 'unranked';
      queue[ws.queueType].push(ws);
      ws.send(JSON.stringify({ type: 'in_queue' }));
      tryMatch(ws.queueType);
    }

    if (msg.type === 'leave_queue') {
      removeFromQueue(ws);
    }

    if (msg.type === 'paddle_move') {
      const game = games.get(ws.gameId);
      if (!game) return;
      const side = game.p1.ws === ws ? 'p1' : 'p2';
      game[side].y = Math.max(0, Math.min(msg.y, game.height - game.paddleH));
    }
  });

  ws.on('close', () => {
    removeFromQueue(ws);
    const game = games.get(ws.gameId);
    if (game) endGame(game, ws.gameId, ws === game.p1.ws ? game.p2.ws : game.p1.ws);
  });
});

function removeFromQueue(ws) {
  for (const type of ['ranked', 'unranked']) {
    const i = queue[type].indexOf(ws);
    if (i !== -1) queue[type].splice(i, 1);
  }
}

function tryMatch(type) {
  while (queue[type].length >= 2) {
    const p1ws = queue[type].shift();
    const p2ws = queue[type].shift();
    createGame(p1ws, p2ws, type === 'ranked');
  }
}

function createGame(p1ws, p2ws, ranked) {
  const W = 800, H = 450, PH = 90;
  const gameId = Math.random().toString(36).slice(2);

  const game = {
    p1: { ws: p1ws, y: H/2 - PH/2, score: 0 },
    p2: { ws: p2ws, y: H/2 - PH/2, score: 0 },
    ball: { x: W/2, y: H/2, dx: 5, dy: 3 },
    width: W, height: H, paddleH: PH, paddleW: 12,
    ranked, running: true,
    interval: null
  };

  p1ws.gameId = gameId;
  p2ws.gameId = gameId;
  games.set(gameId, game);

  const info = (side) => ({
    type: 'game_start',
    side,
    opponent: side === 'p1' ? p2ws.username : p1ws.username,
    ranked,
    width: W, height: H
  });

  p1ws.send(JSON.stringify(info('p1')));
  p2ws.send(JSON.stringify(info('p2')));

  game.interval = setInterval(() => tickGame(game, gameId), 16);
}

function tickGame(game, gameId) {
  if (!game.running) return;
  const { ball, p1, p2, width, height, paddleH, paddleW } = game;

  ball.x += ball.dx;
  ball.y += ball.dy;

  if (ball.y <= 0 || ball.y >= height) ball.dy *= -1;

  // Paddle P1
  if (ball.x < 32 + paddleW && ball.y > p1.y && ball.y < p1.y + paddleH) {
    ball.dx = Math.abs(ball.dx) * 1.05;
    ball.dy += (ball.y - (p1.y + paddleH/2)) * 0.15;
    ball.x = 32 + paddleW;
    if (Math.abs(ball.dx) > 18) ball.dx = 18;
  }
  // Paddle P2
  if (ball.x > width - 32 - paddleW - 10 && ball.y > p2.y && ball.y < p2.y + paddleH) {
    ball.dx = -Math.abs(ball.dx) * 1.05;
    ball.dy += (ball.y - (p2.y + paddleH/2)) * 0.15;
    ball.x = width - 32 - paddleW - 10;
    if (Math.abs(ball.dx) > 18) ball.dx = -18;
  }

  const state = JSON.stringify({
    type: 'state',
    ball: { x: ball.x, y: ball.y },
    p1y: p1.y, p2y: p2.y,
    score1: p1.score, score2: p2.score
  });

  if (p1.ws.readyState === WebSocket.OPEN) p1.ws.send(state);
  if (p2.ws.readyState === WebSocket.OPEN) p2.ws.send(state);

  if (ball.x < 0) {
    p2.score++;
    resetBallServer(game);
    if (p2.score >= 7) { endGame(game, gameId, p2.ws); return; }
  } else if (ball.x > width) {
    p1.score++;
    resetBallServer(game);
    if (p1.score >= 7) { endGame(game, gameId, p1.ws); return; }
  }
}

function resetBallServer(game) {
  game.ball = {
    x: game.width/2, y: game.height/2,
    dx: (Math.random() > 0.5 ? 1 : -1) * 5,
    dy: Math.random() * 4 - 2
  };
}

async function endGame(game, gameId, winnerWs) {
  if (!game.running) return;
  game.running = false;
  clearInterval(game.interval);
  games.delete(gameId);

  const loserWs = winnerWs === game.p1.ws ? game.p2.ws : game.p1.ws;
  let eloChange = 0;

  if (game.ranked && winnerWs.userId && loserWs.userId) {
    const { data: w } = await supabase.from('users').select('elo').eq('id', winnerWs.userId).single();
    const { data: l } = await supabase.from('users').select('elo').eq('id', loserWs.userId).single();
    eloChange = calcElo(w.elo, l.elo);
    const coinsWon = 50 + eloChange;

    await supabase.from('users').update({
      elo: w.elo + eloChange, wins: supabase.rpc('increment', { x: 1 }),
      coins: supabase.rpc('increment', { x: coinsWon })
    }).eq('id', winnerWs.userId);

    await supabase.from('users').update({
      elo: Math.max(0, l.elo - eloChange),
      losses: supabase.rpc('increment', { x: 1 })
    }).eq('id', loserWs.userId);

    await supabase.from('matches').insert({
      player1_id: game.p1.ws.userId, player2_id: game.p2.ws.userId,
      winner_id: winnerWs.userId,
      score1: game.p1.score, score2: game.p2.score,
      ranked: true, elo_change: eloChange
    });
  }

  const result = (ws, won) => JSON.stringify({
    type: 'game_end',
    won,
    eloChange: won ? eloChange : -eloChange,
    score1: game.p1.score, score2: game.p2.score
  });

  if (winnerWs.readyState === WebSocket.OPEN) winnerWs.send(result(winnerWs, true));
  if (loserWs.readyState === WebSocket.OPEN) loserWs.send(result(loserWs, false));
}

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pong Ultra Backend läuft auf Port ${PORT}`));
