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
const SUPABASE_KEY = process.env.SUPABASE_KEY; // In Render Env-Variables setzen!
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

// ── ROUTES: AUTH, ME, LEADERBOARD ───────────────────────
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
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Login fehlgeschlagen.' });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { ...user, rank: getRank(user.elo) } });
});

app.get('/me', auth, async (req, res) => {
    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
    const { data: skins } = await supabase.from('user_skins').select('skin_id').eq('user_id', req.user.id);
    res.json({ ...user, rank: getRank(user.elo), skins: skins.map(s => s.skin_id) });
});

app.get('/leaderboard', async (req, res) => {
    const { data } = await supabase.from('users').select('username, elo, wins').order('elo', { ascending: false }).limit(20);
    res.json(data.map(u => ({ ...u, rank: getRank(u.elo) })));
});

// ── NEU: ACCOUNT & SHOP ────────────────────────────────
app.post('/account/rename', auth, async (req, res) => {
    const { username } = req.body;
    const { error } = await supabase.from('users').update({ username }).eq('id', req.user.id);
    if (error) return res.status(400).json({ error: 'Name vergeben.' });
    res.json({ success: true, username });
});

app.delete('/account', auth, async (req, res) => {
    await supabase.from('user_skins').delete().eq('user_id', req.user.id);
    await supabase.from('users').delete().eq('id', req.user.id);
    res.json({ success: true });
});

// ── WEBSOCKET LOGIK (MATCHMAKING & GAMEPLAY) ───────────
const queue = { ranked: [], unranked: [] };
const games = new Map();

function broadcastOnlineCount() {
    let count = 0;
    wss.clients.forEach(c => { if (c.userId && c.readyState === WebSocket.OPEN) count++; });
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) 
            c.send(JSON.stringify({ type: 'online_count', count }));
    });
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
                const { data: user } = await supabase.from('users').select('*').eq('id', payload.id).single();
                ws.userId = user.id;
                ws.username = user.username;
                ws.send(JSON.stringify({ type: 'auth_ok' }));
                broadcastOnlineCount();
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
            if (ws.queueType) {
                queue[ws.queueType] = queue[ws.queueType].filter(p => p !== ws);
                ws.queueType = null;
            }
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
        if (ws.queueType) queue[ws.queueType] = queue[ws.queueType].filter(p => p !== ws);
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
        const p1 = queue[type].shift();
        const p2 = queue[type].shift();
        createGame(p1, p2, type === 'ranked');
    }
}

function createGame(p1ws, p2ws, ranked) {
    const gameId = Math.random().toString(36).substring(2);
    const game = {
        p1: { ws: p1ws, y: 180, score: 0 },
        p2: { ws: p2ws, y: 180, score: 0 },
        ball: { x: 400, y: 225, dx: 5, dy: 3 },
        width: 800, height: 450
    };
    p1ws.gameId = gameId; p2ws.gameId = gameId;
    games.set(gameId, game);

    p1ws.send(JSON.stringify({ type: 'game_start', side: 'p1', opponent: p2ws.username }));
    p2ws.send(JSON.stringify({ type: 'game_start', side: 'p2', opponent: p1ws.username }));

    game.interval = setInterval(() => {
        // Einfache Physik
        game.ball.x += game.ball.dx;
        game.ball.y += game.ball.dy;

        if (game.ball.y <= 0 || game.ball.y >= 450) game.ball.dy *= -1;

        // Paddle Kollision (vereinfacht)
        if (game.ball.x < 20 && game.ball.y > game.p1.y && game.ball.y < game.p1.y + 90) game.ball.dx *= -1.1;
        if (game.ball.x > 780 && game.ball.y > game.p2.y && game.ball.y < game.p2.y + 90) game.ball.dx *= -1.1;

        // Punktlandung
        if (game.ball.x < 0 || game.ball.x > 800) {
            if (game.ball.x < 0) game.p2.score++; else game.p1.score++;
            game.ball.x = 400; game.ball.y = 225; game.ball.dx = 5 * (Math.random() > 0.5 ? 1 : -1);
        }

        const state = JSON.stringify({
            type: 'state',
            ball: { x: game.ball.x, y: game.ball.y },
            p1y: game.p1.y, p2y: game.p2.y,
            score1: game.p1.score, score2: game.p2.score
        });

        if (p1ws.readyState === 1) p1ws.send(state);
        if (p2ws.readyState === 1) p2ws.send(state);
        
        if (game.p1.score >= 10 || game.p2.score >= 10) {
            clearInterval(game.interval);
            games.delete(gameId);
        }
    }, 16);
}

// Herzschlag-Intervall (Render Alive)
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Backend aktiv auf Port ${PORT}`));
