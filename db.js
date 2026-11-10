// Veri katmanı: DATABASE_URL varsa PostgreSQL (Supabase), yoksa bellek (sadece test için)
const crypto = require('crypto');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = crypto.scryptSync(pw, salt, 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const newToken = () => crypto.randomBytes(32).toString('hex');
const pub = u => u && ({ id: u.id, username: u.username, color: u.color });

// ================= PostgreSQL =================
class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 5,
      connectionTimeoutMillis: 10000, query_timeout: 15000 }); // veritabanı yanıt vermezse takılı kalmasın
    this.pool.on('error', e => console.error('Veritabanı hatası:', e.message));
    this.kind = 'PostgreSQL';
  }
  q(text, params) { return this.pool.query(text, params); }

  async init() {
    await this.q(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT NOT NULL UNIQUE,
        pass_hash TEXT NOT NULL,
        color TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS friendships (
        requester_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        addressee_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (requester_id, addressee_id)
      );
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        p1_id INT REFERENCES users(id) ON DELETE SET NULL,
        p2_id INT REFERENCES users(id) ON DELETE SET NULL,
        p1_score INT NOT NULL,
        p2_score INT NOT NULL,
        winner_id INT REFERENCES users(id) ON DELETE SET NULL,
        duration INT NOT NULL,
        reason TEXT,
        played_at TIMESTAMPTZ DEFAULT now()
      );
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
      ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
    `);
  }

  async createUser(username, password, color) {
    try {
      const r = await this.q(
        'INSERT INTO users (username, username_lower, pass_hash, color) VALUES ($1, $2, $3, $4) RETURNING *',
        [username, username.toLocaleLowerCase('tr'), hashPassword(password), color]);
      return pub(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw new Error('Bu kullanıcı adı alınmış.');
      throw e;
    }
  }
  async login(username, password) {
    const r = await this.q('SELECT * FROM users WHERE username_lower = $1', [username.toLocaleLowerCase('tr')]);
    const u = r.rows[0];
    return u && verifyPassword(password, u.pass_hash) ? pub(u) : null;
  }
  async createSession(userId) {
    const t = newToken();
    await this.q('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [t, userId]);
    return t;
  }
  async userByToken(token) {
    const r = await this.q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1', [token]);
    return pub(r.rows[0]);
  }
  async deleteSession(token) { await this.q('DELETE FROM sessions WHERE token = $1', [token]); }
  async setColor(userId, color) { await this.q('UPDATE users SET color = $1 WHERE id = $2', [color, userId]); }
  async userByName(username) {
    const r = await this.q('SELECT * FROM users WHERE username_lower = $1', [username.toLocaleLowerCase('tr')]);
    return pub(r.rows[0]);
  }
  async getRelation(a, b) {
    const r = await this.q(
      'SELECT * FROM friendships WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)', [a, b]);
    return r.rows[0] || null;
  }
  async addRequest(from, to) {
    await this.q("INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')", [from, to]);
  }
  async acceptRequest(from, to) {
    const r = await this.q("UPDATE friendships SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'", [from, to]);
    return r.rowCount > 0;
  }
  async deleteRelation(a, b) {
    await this.q('DELETE FROM friendships WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)', [a, b]);
  }
  async getSocial(userId) {
    const r = await this.q(`
      SELECT f.requester_id, f.addressee_id, f.status, u.id, u.username
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
      WHERE f.requester_id = $1 OR f.addressee_id = $1
      ORDER BY u.username`, [userId]);
    const out = { friends: [], incoming: [], outgoing: [] };
    for (const row of r.rows) {
      const item = { id: row.id, username: row.username };
      if (row.status === 'accepted') out.friends.push(item);
      else if (row.addressee_id === userId) out.incoming.push(item);
      else out.outgoing.push(item);
    }
    return out;
  }
  async saveMatch(m) {
    await this.q(
      'INSERT INTO matches (p1_id, p2_id, p1_score, p2_score, winner_id, duration, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [m.p1Id, m.p2Id, m.p1Score, m.p2Score, m.winnerId, m.duration, m.reason]);
  }
  async getStats(userId) {
    const s = await this.q(`
      SELECT COUNT(*)::int AS games,
             COUNT(*) FILTER (WHERE winner_id = $1)::int AS wins,
             COUNT(*) FILTER (WHERE winner_id IS NULL)::int AS draws,
             COALESCE(SUM(CASE WHEN p1_id = $1 THEN p1_score ELSE p2_score END), 0)::int AS points,
             COALESCE(MAX(CASE WHEN p1_id = $1 THEN p1_score ELSE p2_score END), 0)::int AS best
      FROM matches WHERE p1_id = $1 OR p2_id = $1`, [userId]);
    const recent = await this.q(`
      SELECT m.played_at, m.duration, m.winner_id,
             CASE WHEN m.p1_id = $1 THEN m.p1_score ELSE m.p2_score END AS my_score,
             CASE WHEN m.p1_id = $1 THEN m.p2_score ELSE m.p1_score END AS opp_score,
             o.username AS opponent
      FROM matches m LEFT JOIN users o ON o.id = CASE WHEN m.p1_id = $1 THEN m.p2_id ELSE m.p1_id END
      WHERE m.p1_id = $1 OR m.p2_id = $1
      ORDER BY m.played_at DESC LIMIT 8`, [userId]);
    const top = await this.q(`
      SELECT u.username, COUNT(m.id)::int AS wins
      FROM matches m JOIN users u ON u.id = m.winner_id
      GROUP BY u.id, u.username ORDER BY wins DESC, u.username LIMIT 10`);
    const st = s.rows[0];
    return {
      stats: { games: st.games, wins: st.wins, losses: st.games - st.wins - st.draws, points: st.points, best: st.best },
      recent: recent.rows.map(r => ({ opponent: r.opponent || '(silinmiş)', myScore: r.my_score, oppScore: r.opp_score,
        won: r.winner_id === userId, draw: r.winner_id === null, duration: r.duration, playedAt: r.played_at })),
      leaderboard: top.rows
    };
  }
}

// ================= Bellek (DATABASE_URL yoksa) =================
class MemoryStore {
  constructor() { this.users = []; this.sessions = new Map(); this.friendships = []; this.matches = []; this.kind = 'Bellek (test modu, yeniden başlatınca silinir)'; }
  async init() {}
  async createUser(username, password, color) {
    const lower = username.toLocaleLowerCase('tr');
    if (this.users.some(u => u.lower === lower)) throw new Error('Bu kullanıcı adı alınmış.');
    const u = { id: this.users.length + 1, username, lower, hash: hashPassword(password), color };
    this.users.push(u);
    return pub(u);
  }
  async login(username, password) {
    const u = this.users.find(x => x.lower === username.toLocaleLowerCase('tr'));
    return u && verifyPassword(password, u.hash) ? pub(u) : null;
  }
  async createSession(userId) { const t = newToken(); this.sessions.set(t, userId); return t; }
  async userByToken(token) { return pub(this.users.find(u => u.id === this.sessions.get(token))); }
  async deleteSession(token) { this.sessions.delete(token); }
  async setColor(userId, color) { const u = this.users.find(x => x.id === userId); if (u) u.color = color; }
  async userByName(username) { return pub(this.users.find(x => x.lower === username.toLocaleLowerCase('tr'))); }
  async getRelation(a, b) {
    const f = this.friendships.find(f => (f.r === a && f.a === b) || (f.r === b && f.a === a));
    return f ? { requester_id: f.r, addressee_id: f.a, status: f.status } : null;
  }
  async addRequest(from, to) { this.friendships.push({ r: from, a: to, status: 'pending' }); }
  async acceptRequest(from, to) {
    const f = this.friendships.find(f => f.r === from && f.a === to && f.status === 'pending');
    if (f) f.status = 'accepted';
    return !!f;
  }
  async deleteRelation(a, b) { this.friendships = this.friendships.filter(f => !((f.r === a && f.a === b) || (f.r === b && f.a === a))); }
  async getSocial(userId) {
    const out = { friends: [], incoming: [], outgoing: [] };
    for (const f of this.friendships) {
      if (f.r !== userId && f.a !== userId) continue;
      const other = this.users.find(u => u.id === (f.r === userId ? f.a : f.r));
      const item = { id: other.id, username: other.username };
      if (f.status === 'accepted') out.friends.push(item);
      else if (f.a === userId) out.incoming.push(item);
      else out.outgoing.push(item);
    }
    return out;
  }
  async saveMatch(m) { this.matches.push({ ...m, playedAt: new Date() }); }
  async getStats(userId) {
    const mine = this.matches.filter(m => m.p1Id === userId || m.p2Id === userId);
    const my = m => (m.p1Id === userId ? m.p1Score : m.p2Score);
    const wins = mine.filter(m => m.winnerId === userId).length;
    const draws = mine.filter(m => m.winnerId === null).length;
    const winCount = {};
    for (const m of this.matches) if (m.winnerId) winCount[m.winnerId] = (winCount[m.winnerId] || 0) + 1;
    return {
      stats: { games: mine.length, wins, losses: mine.length - wins - draws, points: mine.reduce((a, m) => a + my(m), 0), best: Math.max(0, ...mine.map(my)) },
      recent: mine.slice(-8).reverse().map(m => {
        const oppId = m.p1Id === userId ? m.p2Id : m.p1Id;
        return { opponent: (this.users.find(u => u.id === oppId) || {}).username, myScore: my(m), oppScore: m.p1Id === userId ? m.p2Score : m.p1Score,
          won: m.winnerId === userId, draw: m.winnerId === null, duration: m.duration, playedAt: m.playedAt };
      }),
      leaderboard: Object.entries(winCount).map(([id, wins]) => ({ username: this.users.find(u => u.id === +id).username, wins })).sort((a, b) => b.wins - a.wins).slice(0, 10)
    };
  }
}

module.exports = function createStore() {
  return process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new MemoryStore();
};
