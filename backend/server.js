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

// ── KONFIGURATION ───────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || "https://leumrsdjjgvgepoevwsf.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_secret_FUUT4OMj9dPh8ORwPJBw6A_hnIZG3Kn";
const JWT_SECRET = process.env.JWT_SECRET || 'pong-ultra-secret';

if (!SUPABASE_URL) {
  console.error("KRITISCHER FEHLER: SUPABASE_URL ist nicht definiert!");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── MIDDLEWARE ──────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // enthält die id
    next();
  } catch {
    res.status(401).json({ error: 'Token ungültig.' });
  }
};

// ── RANKS & ELO ─────────────────────────────────────────
const RANKS = [
  { name: 'Iron I', min: 0 }, { name: 'Iron II', min: 100 },
  { name: 'Bronze I', min: 200 }, { name: 'Bronze II', min: 300 },
  { name: 'Silver I', min: 400 }, { name: 'Silver II', min: 500 },
  { name: 'Gold I', min: 600 }, { name: 'Gold II', min: 700 },
  { name: 'Platinum I', min: 800 }, { name: 'Platinum II', min: 900 },
  { name: 'Diamond I', min: 1000 }, { name: 'Diamond II', min: 1100 },
  { name: 'Master I', min: 1200 }, { name: 'Master II', min: 1350 },
  { name: 'Grandmaster I', min: 1500 }, { name: 'Grandmaster II', min: 1650 },
  { name: 'Challenger I', min: 1800 }, { name: 'Challenger II', min: 1950 },
  { name: 'Challenger III', min: 2100 }, { name: 'Apex', min: 2300 }
];

function getRank(elo) {
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (elo >= RANKS[i].min) return RANKS[i].name;
  }
  return RANKS[0].name;
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

app.get('/me', auth, async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('id, username, email, elo, coins, wins, losses')
    .eq('id', req.user.id).single();

  if (!user) return res.status(404).json({ error: 'Nutzer nicht gefunden.' });

  const { data: skins } = await supabase
    .from('user_skins').select('skin_id').eq('user_id', req.user.id);

  res.json({
    ...user,
    rank: getRank(user.elo),
    skins: skins ? skins.map(s => s.skin_id) : []
  });
});

// ── ACCOUNT MANAGEMENT ─────────────────────────────────
app.post('/account/rename', auth, async (req, res) => {
  const { username } = req.body;
  if (!username || username.length < 3 || username.length > 20)
    return res.status(400).json({ error: 'Benutzername muss 3–20 Zeichen lang sein.' });

  const { data: existing } = await supabase
    .from('users').select('id').eq('username', username).single();
  
  if (existing) return res.status(400).json({ error: 'Dieser Name ist bereits vergeben.' });

  const { error } = await supabase
    .from('users').update({ username }).eq('id', req.user.id);
    
  if (error) return res.status(500).json({ error: 'Fehler beim Speichern.' });

  res.json({ success: true, username });
});

app.delete('/account', auth, async (req, res) => {
  try {
    await supabase.from('user_skins').delete().eq('user_id', req.user.id);
    await supabase.from('matches').update({ player1_id: null }).eq('player1_id', req.user.id);
    await supabase.from('matches').update({ player2_id: null }).eq('player2_id', req.user.id);
    await supabase.from('users').delete().eq('id', req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Löschen fehlgeschlagen.' });
  }
});

app.get('/leaderboard', async (req, res) => {
  const { data } = await supabase
    .from('users').select('username, elo, wins').order('elo', { ascending: false }).limit(20);
  res.json(data.map(u => ({ ...u, rank: getRank(u.elo) })));
});

// ── WEBSOCKET LOGIK ────────────────────────────────────
const queue = { ranked: [], unranked: [] };
const games = new Map();

function broadcastOnlineCount() {
  let count = 0;
  wss.clients.forEach(c => { if (c.userId && c.readyState === WebSocket.OPEN) count++; });
  const msg = JSON.stringify({ type: 'online_count', count });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', (ws) => {
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
        broadcastOnlineCount(); 
      } catch { 
        ws.send(JSON.stringify({ type: 'auth_fail' })); 
      }
    }

    if (msg.type === 'join_queue') {
      if (!ws.userId) return;
      ws.queueType = msg.ranked ? 'ranked' : 'unranked';
      queue[ws.queueType].push(ws);
      ws.send(JSON.stringify({ type: 'in_queue' }));
      tryMatch(ws.queueType);
    }

    if (msg.type === 'paddle_move') {
      const game = games.get(ws.gameId);
      if (game) {
        const side = game.p1.ws === ws ? 'p1' : 'p2';
        game[side].y = msg.y;
      }
    }
  });

  ws.on('close', () => {
    // Aus Queue entfernen
    if (ws.queueType) {
      queue[ws.queueType] = queue[ws.queueType].filter(p => p !== ws);
    }
    // Spiel beenden falls aktiv
    const game = games.get(ws.gameId);
    if (game) {
      clearInterval(game.interval);
      games.delete(ws.gameId);
    }
    setTimeout(broadcastOnlineCount, 100);
  });
});

function tryMatch(type) {
  while (queue[type].length >= 2) {
    const p1ws = queue[type].shift();
    const p2ws = queue[type].shift();
    createGame(p1ws, p2ws, type === 'ranked');
  }
}

function createGame(p1ws, p2ws, ranked) {
  const W = 800, H = 450;
  const gameId = Math.random().toString(36).slice(2);
  const game = {
    p1: { ws: p1ws, y: H/2-45, score: 0 },
    p2: { ws: p2ws, y: H/2-45, score: 0 },
    ball: { x: W/2, y: H/2, dx: 5, dy: 3 },
    width: W, height: H, ranked, running: true
  };
  p1ws.gameId = gameId; p2ws.gameId = gameId;
  games.set(gameId, game);
  
  p1ws.send(JSON.stringify({ type: 'game_start', side: 'p1', opponent: p2ws.username, width: W, height: H }));
  p2ws.send(JSON.stringify({ type: 'game_start', side: 'p2', opponent: p1ws.username, width: W, height: H }));
  
  game.interval = setInterval(() => tick(game, gameId), 16);
}

function tick(game, gameId) {
  game.ball.x += game.ball.dx;
  game.ball.y += game.ball.dy;
  
  if(game.ball.y < 0 || game.ball.y > game.height) game.ball.dy *= -1;
  
  if(game.ball.x < 0 || game.ball.x > game.width) {
    if(game.ball.x < 0) game.p2.score++; else game.p1.score++;
    game.ball.x = game.width/2; game.ball.y = game.height/2;
  }

  const state = JSON.stringify({ 
    type: 'state', 
    ball: {x: game.ball.x, y: game.ball.y}, 
    p1y: game.p1.y, 
    p2y: game.p2.y, 
    score1: game.p1.score, 
    score2: game.p2.score 
  });
  
  if (game.p1.ws.readyState === WebSocket.OPEN) game.p1.ws.send(state);
  if (game.p2.ws.readyState === WebSocket.OPEN) game.p2.ws.send(state);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
