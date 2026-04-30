/**
 * TechPulse V2 Backend
 * Node.js + Express + SQLite (better-sqlite3)
 * 
 * Cài đặt: npm install express better-sqlite3 bcryptjs jsonwebtoken multer
 * Chạy: node backend.js
 * 
 * API ROUTES:
 * Public:
 *   GET  /api/articles              Danh sách bài
 *   GET  /api/articles/:id          Chi tiết 1 bài
 *   POST /api/track/view            Ghi lượt vào bài
 *   POST /api/track/ping            Cập nhật % đọc
 * 
 * Admin (JWT required):
 *   POST   /api/admin/login
 *   GET    /api/admin/articles
 *   POST   /api/admin/articles
 *   PUT    /api/admin/articles/:id
 *   DELETE /api/admin/articles/:id
 *   POST   /api/upload
 * 
 * Stats (JWT required):
 *   GET /api/admin/stats/overview
 *   GET /api/admin/stats/article/:id
 *   GET /api/admin/stats/readers
 */

'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'techpulse-v2-secret';
const JWT_EXPIRES = '7d';
const DB_PATH = path.join(__dirname, 'techpulse.db');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Tạo thư mục uploads
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype);
    cb(ok ? null : new Error('Chỉ chấp nhận ảnh'), ok);
  }
});

// Database init
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    excerpt TEXT,
    content TEXT,
    thumbnail TEXT,
    category TEXT DEFAULT 'general',
    tags TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    is_featured INTEGER DEFAULT 0,
    status TEXT DEFAULT 'published'
  );

  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    referrer TEXT,
    search_keyword TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS read_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now')),
    last_ping_at TEXT DEFAULT (datetime('now')),
    read_percent INTEGER DEFAULT 0,
    UNIQUE(article_id, session_id),
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS daily_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    article_id INTEGER NOT NULL,
    total_views INTEGER DEFAULT 0,
    unique_sessions INTEGER DEFAULT 0,
    avg_read_percent REAL DEFAULT 0,
    UNIQUE(day, article_id),
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
  CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_page_views_article ON page_views(article_id);
  CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at);
  CREATE INDEX IF NOT EXISTS idx_read_sessions_article ON read_sessions(article_id);
  CREATE INDEX IF NOT EXISTS idx_daily_summary_day ON daily_summary(day);
  CREATE INDEX IF NOT EXISTS idx_daily_summary_article ON daily_summary(article_id);
`);

// Seed admin nếu chưa có (password: admin123)
if (db.prepare('SELECT COUNT(*) as c FROM admin').get().c === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO admin (id, password_hash) VALUES (1, ?)').run(hash);
  console.log('[SEED] Admin account created: password = admin123');
}

// Prepared statements
const stmt = {
  // Articles
  articleList: db.prepare(`
    SELECT id, title, excerpt, thumbnail, category, tags, created_at, is_featured, status
    FROM articles
    WHERE status = 'published'
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `),
  articleCount: db.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'published'"),
  articleById: db.prepare('SELECT * FROM articles WHERE id = ?'),
  articleSearch: db.prepare(`
    SELECT id, title, excerpt, thumbnail, category, tags, created_at, is_featured
    FROM articles
    WHERE status = 'published' AND (title LIKE ? OR excerpt LIKE ? OR content LIKE ?)
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `),
  articleSearchCount: db.prepare(`
    SELECT COUNT(*) as c FROM articles
    WHERE status = 'published' AND (title LIKE ? OR excerpt LIKE ? OR content LIKE ?)
  `),
  articleByCategory: db.prepare(`
    SELECT id, title, excerpt, thumbnail, category, tags, created_at, is_featured
    FROM articles
    WHERE status = 'published' AND category = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `),
  articleByCategoryCount: db.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'published' AND category = ?"),
  
  // Admin
  adminById: db.prepare('SELECT * FROM admin WHERE id = ?'),
  adminArticleList: db.prepare('SELECT * FROM articles ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  adminArticleCount: db.prepare('SELECT COUNT(*) as c FROM articles'),
  insertArticle: db.prepare(`
    INSERT INTO articles (title, excerpt, content, thumbnail, category, tags, is_featured, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateArticle: db.prepare(`
    UPDATE articles SET
      title = ?, excerpt = ?, content = ?, thumbnail = ?,
      category = ?, tags = ?, is_featured = ?, status = ?
    WHERE id = ?
  `),
  deleteArticle: db.prepare('DELETE FROM articles WHERE id = ?'),

  // Tracking
  insertPageView: db.prepare(`
    INSERT OR IGNORE INTO page_views (article_id, session_id, referrer, search_keyword)
    VALUES (?, ?, ?, ?)
  `),
  upsertReadSession: db.prepare(`
    INSERT INTO read_sessions (article_id, session_id, read_percent, last_ping_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(article_id, session_id) DO UPDATE SET
      read_percent = excluded.read_percent,
      last_ping_at = datetime('now')
  `),

  // Stats
  viewsLast7Days: db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as views
    FROM page_views
    WHERE created_at >= datetime('now', '-7 days')
    GROUP BY day
    ORDER BY day ASC
  `),
  uniqueSessions7Days: db.prepare(`
    SELECT COUNT(DISTINCT session_id) as c
    FROM page_views
    WHERE created_at >= datetime('now', '-7 days')
  `),
  avgReadPercent7Days: db.prepare(`
    SELECT ROUND(AVG(read_percent), 1) as avg
    FROM read_sessions
    WHERE started_at >= datetime('now', '-7 days')
  `),
  topArticles7Days: db.prepare(`
    SELECT a.id, a.title, a.thumbnail, COUNT(pv.id) as views
    FROM articles a
    LEFT JOIN page_views pv ON pv.article_id = a.id AND pv.created_at >= datetime('now', '-7 days')
    WHERE a.status = 'published'
    GROUP BY a.id
    ORDER BY views DESC
    LIMIT 5
  `),
  articleViews: db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as views
    FROM page_views
    WHERE article_id = ?
    GROUP BY day
    ORDER BY day ASC
  `),
  articleReadDist: db.prepare(`
    SELECT
      SUM(CASE WHEN read_percent BETWEEN 0 AND 25 THEN 1 ELSE 0 END) as r0_25,
      SUM(CASE WHEN read_percent BETWEEN 26 AND 50 THEN 1 ELSE 0 END) as r26_50,
      SUM(CASE WHEN read_percent BETWEEN 51 AND 75 THEN 1 ELSE 0 END) as r51_75,
      SUM(CASE WHEN read_percent BETWEEN 76 AND 100 THEN 1 ELSE 0 END) as r76_100
    FROM read_sessions
    WHERE article_id = ?
  `),
  articleKeywords: db.prepare(`
    SELECT search_keyword, COUNT(*) as c
    FROM page_views
    WHERE article_id = ? AND search_keyword IS NOT NULL AND search_keyword != ''
    GROUP BY search_keyword
    ORDER BY c DESC
    LIMIT 10
  `),
  readerSessions: db.prepare(`
    SELECT DISTINCT session_id
    FROM page_views
    WHERE created_at >= datetime('now', '-7 days')
    ORDER BY created_at DESC
    LIMIT 100
  `),
  sessionArticles: db.prepare(`
    SELECT pv.article_id, a.title, rs.read_percent, pv.created_at
    FROM page_views pv
    LEFT JOIN articles a ON a.id = pv.article_id
    LEFT JOIN read_sessions rs ON rs.article_id = pv.article_id AND rs.session_id = pv.session_id
    WHERE pv.session_id = ?
    ORDER BY pv.created_at DESC
  `),
  articleSessions: db.prepare(`
    SELECT pv.session_id, rs.read_percent, pv.created_at
    FROM page_views pv
    LEFT JOIN read_sessions rs ON rs.article_id = pv.article_id AND rs.session_id = pv.session_id
    WHERE pv.article_id = ?
    ORDER BY pv.created_at DESC
  `),
};

// Helpers
const ok = (res, data) => res.json({ success: true, data });
const err = (res, message, status = 400) => res.status(status).json({ success: false, error: message });

// Auth middleware
const requireAdmin = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return err(res, 'Cần đăng nhập', 401);
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return err(res, 'Token không hợp lệ', 401);
  }
};

// ============================================================
// PUBLIC ROUTES
// ============================================================

// GET /api/articles
app.get('/api/articles', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;
  const category = req.query.category;
  const search = req.query.search;

  let items, total;

  if (search) {
    const q = '%' + search + '%';
    items = stmt.articleSearch.all(q, q, q, limit, offset);
    total = stmt.articleSearchCount.get(q, q, q).c;
  } else if (category) {
    items = stmt.articleByCategory.all(category, limit, offset);
    total = stmt.articleByCategoryCount.get(category).c;
  } else {
    items = stmt.articleList.all(limit, offset);
    total = stmt.articleCount.get().c;
  }

  items = items.map(a => ({
    ...a,
    tags: JSON.parse(a.tags || '[]'),
    is_featured: a.is_featured === 1
  }));

  ok(res, {
    items,
    total,
    page,
    pages: Math.ceil(total / limit),
    limit
  });
});

// GET /api/articles/:id
app.get('/api/articles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const article = stmt.articleById.get(id);
  if (!article) return err(res, 'Không tìm thấy bài viết', 404);
  
  article.tags = JSON.parse(article.tags || '[]');
  article.is_featured = article.is_featured === 1;
  
  ok(res, article);
});

// POST /api/track/view
app.post('/api/track/view', (req, res) => {
  const { article_id, session_id, referrer, search_keyword } = req.body;
  if (!article_id || !session_id) return err(res, 'Thiếu article_id hoặc session_id');
  
  stmt.insertPageView.run(
    parseInt(article_id),
    String(session_id).slice(0, 100),
    String(referrer || '').slice(0, 500),
    String(search_keyword || '').slice(0, 200)
  );
  
  ok(res, { tracked: true });
});

// POST /api/track/ping
app.post('/api/track/ping', (req, res) => {
  const { article_id, session_id, read_percent } = req.body;
  if (!article_id || !session_id) return err(res, 'Thiếu article_id hoặc session_id');
  
  const percent = Math.max(0, Math.min(100, parseInt(read_percent) || 0));
  
  stmt.upsertReadSession.run(
    parseInt(article_id),
    String(session_id).slice(0, 100),
    percent
  );
  
  ok(res, { updated: true, read_percent: percent });
});

// ============================================================
// ADMIN ROUTES
// ============================================================

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) return err(res, 'Thiếu mật khẩu');
  
  const admin = stmt.adminById.get(1);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return err(res, 'Mật khẩu không đúng', 401);
  }
  
  const token = jwt.sign({ id: 1, role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  ok(res, { token });
});

// GET /api/admin/articles
app.get('/api/admin/articles', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  
  const items = stmt.adminArticleList.all(limit, offset).map(a => ({
    ...a,
    tags: JSON.parse(a.tags || '[]'),
    is_featured: a.is_featured === 1
  }));
  const total = stmt.adminArticleCount.get().c;
  
  ok(res, {
    items,
    total,
    page,
    pages: Math.ceil(total / limit),
    limit
  });
});

// POST /api/admin/articles
app.post('/api/admin/articles', requireAdmin, (req, res) => {
  const { title, excerpt, content, thumbnail, category, tags, is_featured, status } = req.body;
  if (!title) return err(res, 'Thiếu tiêu đề');
  
  const info = stmt.insertArticle.run(
    String(title).slice(0, 500),
    String(excerpt || '').slice(0, 1000),
    String(content || ''),
    String(thumbnail || '').slice(0, 500),
    String(category || 'general').slice(0, 50),
    JSON.stringify(Array.isArray(tags) ? tags.slice(0, 10) : []),
    is_featured ? 1 : 0,
    status === 'draft' ? 'draft' : 'published'
  );
  
  const created = stmt.articleById.get(info.lastInsertRowid);
  created.tags = JSON.parse(created.tags || '[]');
  created.is_featured = created.is_featured === 1;
  res.status(201).json({ success: true, data: created });
});

// PUT /api/admin/articles/:id
app.put('/api/admin/articles/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const article = stmt.articleById.get(id);
  if (!article) return err(res, 'Không tìm thấy bài viết', 404);
  
  const { title, excerpt, content, thumbnail, category, tags, is_featured, status } = req.body;
  
  stmt.updateArticle.run(
    String(title || article.title).slice(0, 500),
    String(excerpt !== undefined ? excerpt : article.excerpt).slice(0, 1000),
    String(content !== undefined ? content : article.content),
    String(thumbnail !== undefined ? thumbnail : article.thumbnail).slice(0, 500),
    String(category || article.category).slice(0, 50),
    JSON.stringify(Array.isArray(tags) ? tags.slice(0, 10) : JSON.parse(article.tags || '[]')),
    is_featured !== undefined ? (is_featured ? 1 : 0) : article.is_featured,
    status || article.status,
    id
  );
  
  const updated = stmt.articleById.get(id);
  updated.tags = JSON.parse(updated.tags || '[]');
  updated.is_featured = updated.is_featured === 1;
  ok(res, updated);
});

// DELETE /api/admin/articles/:id
app.delete('/api/admin/articles/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const article = stmt.articleById.get(id);
  if (!article) return err(res, 'Không tìm thấy bài viết', 404);
  
  stmt.deleteArticle.run(id);
  ok(res, { deleted: true, id });
});

// POST /api/upload
app.post('/api/upload', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return err(res, 'Không có file');
  const url = '/uploads/' + req.file.filename;
  ok(res, { url });
});

// ============================================================
// STATS ROUTES
// ============================================================

// GET /api/admin/stats/overview
app.get('/api/admin/stats/overview', requireAdmin, (req, res) => {
  const views7d = stmt.viewsLast7Days.all();
  const uniqueSessions = stmt.uniqueSessions7Days.get().c || 0;
  const avgRead = stmt.avgReadPercent7Days.get().avg || 0;
  const topArticles = stmt.topArticles7Days.all().map(a => ({
    ...a,
    thumbnail: a.thumbnail || ''
  }));
  
  ok(res, {
    views_7d: views7d,
    unique_sessions: uniqueSessions,
    avg_read_percent: avgRead,
    top_articles: topArticles
  });
});

// GET /api/admin/stats/article/:id
app.get('/api/admin/stats/article/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const article = stmt.articleById.get(id);
  if (!article) return err(res, 'Không tìm thấy bài viết', 404);
  
  const views = stmt.articleViews.all(id);
  const dist = stmt.articleReadDist.get(id);
  const keywords = stmt.articleKeywords.all(id);
  
  ok(res, {
    article: {
      id: article.id,
      title: article.title,
      thumbnail: article.thumbnail
    },
    views,
    read_distribution: {
      '0-25%': dist.r0_25 || 0,
      '26-50%': dist.r26_50 || 0,
      '51-75%': dist.r51_75 || 0,
      '76-100%': dist.r76_100 || 0
    },
    top_keywords: keywords
  });
});

// GET /api/admin/stats/readers
app.get('/api/admin/stats/readers', requireAdmin, (req, res) => {
  // Lấy tất cả sessions trong 7 ngày
  const sessions = stmt.readerSessions.all();

  // Lấy tất cả page_views + read_sessions trong 1 query
  const allViews = db.prepare(`
    SELECT pv.session_id, pv.article_id, a.title, rs.read_percent, pv.created_at
    FROM page_views pv
    LEFT JOIN articles a ON a.id = pv.article_id
    LEFT JOIN read_sessions rs ON rs.article_id = pv.article_id AND rs.session_id = pv.session_id
    WHERE pv.created_at >= datetime('now', '-7 days')
    ORDER BY pv.created_at DESC
  `).all();

  // Group by session
  const sessionMap = sessions.map(s => {
    const articles = allViews
      .filter(v => v.session_id === s.session_id)
      .map(v => ({
        article_id: v.article_id,
        title: v.title,
        read_percent: v.read_percent || 0,
        viewed_at: v.created_at
      }));
    return { session_id: s.session_id, articles };
  });

  // Top 20 bài có nhiều sessions nhất
  const articleIds = db.prepare(`
    SELECT article_id, COUNT(DISTINCT session_id) as session_count
    FROM page_views
    WHERE created_at >= datetime('now', '-7 days')
    GROUP BY article_id
    ORDER BY session_count DESC
    LIMIT 20
  `).all();

  const articleMap = articleIds.map(a => {
    const article = stmt.articleById.get(a.article_id);
    const sessions = allViews
      .filter(v => v.article_id === a.article_id)
      .map(v => ({
        session_id: v.session_id,
        read_percent: v.read_percent || 0,
        viewed_at: v.created_at
      }));
    return {
      article_id: a.article_id,
      title: article ? article.title : 'Unknown',
      sessions
    };
  });

  ok(res, { by_session: sessionMap, by_article: articleMap });
});

// ============================================================
// NIGHTLY CLEANUP JOB
// Chạy mỗi 24h: xóa raw data cũ hơn 30 ngày
// ============================================================

function runCleanup() {
  try {
    // Bước 1: Gom page_views cũ hơn 7 ngày vào daily_summary
    db.prepare(`
      INSERT INTO daily_summary (day, article_id, total_views, unique_sessions)
        SELECT
          date(pv.created_at) AS day,
          pv.article_id,
          COUNT(*) AS total_views,
          COUNT(DISTINCT pv.session_id) AS unique_sessions
        FROM page_views pv
        WHERE pv.created_at < datetime('now', '-7 days')
        GROUP BY date(pv.created_at), pv.article_id
      ON CONFLICT(day, article_id) DO UPDATE SET
        total_views     = excluded.total_views,
        unique_sessions = excluded.unique_sessions
    `).run();

    // Bước 2: Gom avg_read_percent từ read_sessions cũ hơn 7 ngày vào daily_summary
    db.prepare(`
      INSERT INTO daily_summary (day, article_id, avg_read_percent)
        SELECT
          date(rs.started_at) AS day,
          rs.article_id,
          AVG(rs.read_percent) AS avg_read_percent
        FROM read_sessions rs
        WHERE rs.started_at < datetime('now', '-7 days')
        GROUP BY date(rs.started_at), rs.article_id
      ON CONFLICT(day, article_id) DO UPDATE SET
        avg_read_percent = excluded.avg_read_percent
    `).run();

    console.log('[Cleanup] Gom raw data cũ hơn 7 ngày vào daily_summary xong');

    // Bước 3: Xóa raw data cũ hơn 30 ngày
    const pvDel = db.prepare(`
      DELETE FROM page_views
      WHERE created_at < datetime('now', '-30 days')
    `).run();

    const rsDel = db.prepare(`
      DELETE FROM read_sessions
      WHERE started_at < datetime('now', '-30 days')
    `).run();

    console.log(`[Cleanup] Xóa ${pvDel.changes} page_views, ${rsDel.changes} read_sessions cũ hơn 30 ngày`);
  } catch (e) {
    console.error('[Cleanup] Lỗi:', e.message);
  }
}

// Chạy ngay khi khởi động, sau đó mỗi 24h
runCleanup();
setInterval(runCleanup, 24 * 60 * 60 * 1000);

// ============================================================
// START SERVER
// ============================================================

// ── KEEP-ALIVE: tự ping mỗi 12 phút để free tier không sleep ──
const http = require('http');
const https = require('https');
function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return; // chỉ chạy trên Render
  const mod = url.startsWith('https') ? https : http;
  mod.get(url + '/api/articles?limit=1', (res) => {
    console.log('[KeepAlive] ping OK', res.statusCode);
  }).on('error', (e) => {
    console.log('[KeepAlive] ping fail:', e.message);
  });
}
setInterval(keepAlive, 12 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`[TechPulse V2] Server running on http://localhost:${PORT}`);
  console.log('[DB] Database: ' + DB_PATH);
  console.log('[UPLOAD] Upload directory: ' + UPLOAD_DIR);
});
