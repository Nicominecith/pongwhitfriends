-- Nutzer
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  elo INT DEFAULT 1000,
  coins INT DEFAULT 500,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Gekaufte Skins
CREATE TABLE user_skins (
  user_id UUID REFERENCES users(id),
  skin_id TEXT NOT NULL,
  PRIMARY KEY (user_id, skin_id)
);

-- Match-Historie
CREATE TABLE matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player1_id UUID REFERENCES users(id),
  player2_id UUID REFERENCES users(id),
  winner_id UUID REFERENCES users(id),
  score1 INT,
  score2 INT,
  ranked BOOLEAN DEFAULT true,
  elo_change INT,
  played_at TIMESTAMPTZ DEFAULT NOW()
);
