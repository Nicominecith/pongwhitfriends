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
const SUPABASE_KEY = process.env.SUPABASE_KEY; 
const JWT_SECRET = process.env.JWT_SECRET || 'pong-ultra-secret';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── MIDDLEWARE ──────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; 
    next();
  } catch {
    res.status(401).json({ error: 'Token ungültig.' });
  }
};

// ── RANKS ──────────────────────────────────────────────
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

// ── ROUTES: AUTH & ME ──────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users').insert({ username, email, password_hash: hash }).select('*').single();
  if (error) return res.status(400).json({ error: 'Name oder Email vergeben.' });
  await supabase.from('user_skins').insert({ user_id: data.id, skin_id: 'default' });
  const token = jwt.sign({ id: data.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { ...data, rank: getRank(data.elo) } });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Falsche Daten.' });
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { ...user, rank: getRank(user.elo) } });
});

app.get('/me', auth, async (req, res) => {
  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  const { data: skins } = await supabase.from('user_skins').select('skin_id').eq('user_id', req.user.id);
  res.json({ ...user, rank: getRank(user.elo), skins: skins.map(s => s.skin_id) });
});

// ── NEU: ACCOUNT MANAGEMENT ────────────────────────────
app.post('/account/rename', auth, async (req, res) => {
  const { username } = req.body;
  if (!username || username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Name zu kurz/lang.' });
  const { error } = await supabase.from('users').update({ username }).eq('id', req.user.id);
  if (error) return res.status(400).json({ error: 'Name bereits vergeben.' });
  res.json({ success: true, username });
});

app.delete('/account', auth, async (req, res) => {
  await supabase.from('user_skins').delete().eq('user_id', req.user.id);
  await supabase.from('matches').update({ player1_id: null }).eq('player1_id', req.user.id);
  await supabase.from('matches').update({ player2_id: null }).eq('player2_id', req.user.id);
  await supabase.from('users').delete().eq('id', req.user.id);
  res.json({ success: true });
});

// ── WEBSOCKET ONLINE COUNT ─────────────────────────────
function broadcastOnlineCount() {
  let count = 0;
  wss.clients.forEach(c => { if (c.userId && c.readyState === WebSocket.OPEN) count++; });
  const msg = JSON.stringify({ type: 'online_count', count });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'auth') {
      try {
        const payload = jwt.verify(msg.token, JWT_SECRET);
        ws.userId = payload.id;
        broadcastOnlineCount();
        ws.send(JSON.stringify({ type: 'auth_ok' }));
      } catch { ws.send(JSON.stringify({ type: 'auth_fail' })); }
    }
  });
  ws.on('close', () => {
    setTimeout(broadcastOnlineCount, 100);
  });
});

app.get('/leaderboard', async (req, res) => {
  const { data } = await supabase.from('users').select('username, elo, wins').order('elo', { ascending: false }).limit(20);
  res.json(data.map(u => ({ ...u, rank: getRank(u.elo) })));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
