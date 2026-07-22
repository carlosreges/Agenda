const path = require('path');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;
const isVercel = Boolean(process.env.VERCEL);
const dbPath = process.env.DB_PATH || (isVercel ? '/tmp/agenda.db' : path.join(__dirname, 'data', 'agenda.db'));
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING || null;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'agenda-apoyo-escolar.html'));
});

app.get('/agenda-apoyo-escolar.html', (_req, res) => {
  res.sendFile(path.join(__dirname, 'agenda-apoyo-escolar.html'));
});

const fs = require('fs');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

let pgPool = null;
let db = null;

if (DATABASE_URL) {
  pgPool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
} else {
  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      block_id TEXT NOT NULL,
      name TEXT NOT NULL,
      subject TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS known_students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      subject TEXT,
      last_used_at TEXT NOT NULL
    );
  `);
}

function normalizeDate(date) {
  return date || new Date().toISOString().slice(0, 10);
}

function blockDefsForDate(date) {
  const day = new Date(`${date}T00:00:00`).getDay();
  if (day === 0) return [];
  if (day >= 1 && day <= 5) {
    return [
      { id: '08-09', start: '8:00', end: '9:00', modality: 'virtual' },
      { id: '09-10', start: '9:00', end: '10:00', modality: 'presencial' },
      { id: '10-11', start: '10:00', end: '11:00', modality: 'presencial' },
      { id: '11-12', start: '11:00', end: '12:00', modality: 'presencial' },
      { id: '15-16', start: '15:00', end: '16:00', modality: 'presencial' },
      { id: '16-17', start: '16:00', end: '17:00', modality: 'presencial' },
      { id: '17-18', start: '17:00', end: '18:00', modality: 'presencial' },
      { id: '18-19', start: '18:00', end: '19:00', modality: 'virtual' },
      { id: '19-20', start: '19:00', end: '20:00', modality: 'virtual' }
    ];
  }
  return [
    { id: '09-10', start: '9:00', end: '10:00', modality: 'presencial' },
    { id: '10-11', start: '10:00', end: '11:00', modality: 'presencial' },
    { id: '11-12', start: '11:00', end: '12:00', modality: 'presencial' }
  ];
}

function uid() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function getDayData(date) {
  const blocks = {};
  if (pgPool) {
    const res = await pgPool.query('SELECT id, block_id, name, subject, notes FROM students WHERE date = $1 ORDER BY created_at ASC', [date]);
    res.rows.forEach((row) => {
      if (!blocks[row.block_id]) blocks[row.block_id] = [];
      blocks[row.block_id].push({ id: row.id, name: row.name, subject: row.subject, notes: row.notes });
    });
    return { date, blocks };
  }
  const rows = db.prepare('SELECT * FROM students WHERE date = ? ORDER BY created_at ASC').all(date);
  rows.forEach((row) => {
    if (!blocks[row.block_id]) blocks[row.block_id] = [];
    blocks[row.block_id].push({ id: row.id, name: row.name, subject: row.subject, notes: row.notes });
  });
  return { date, blocks };
}

async function listKnownStudents() {
  if (pgPool) {
    const res = await pgPool.query('SELECT name, subject FROM known_students ORDER BY last_used_at DESC LIMIT 80');
    return res.rows.map((r) => ({ name: r.name, subject: r.subject || '' }));
  }
  const rows = db.prepare('SELECT name, subject FROM known_students ORDER BY last_used_at DESC LIMIT 80').all();
  return rows.map((row) => ({ name: row.name, subject: row.subject || '' }));
}

async function upsertKnownStudent(name, subject) {
  const cleanName = name.trim();
  if (!cleanName) return;
  const now = new Date().toISOString();
  if (pgPool) {
    await pgPool.query(`
      INSERT INTO known_students (name, subject, last_used_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (name) DO UPDATE SET subject = EXCLUDED.subject, last_used_at = EXCLUDED.last_used_at
    `, [cleanName, (subject || '').trim(), now]);
    return;
  }
  db.prepare(`
    INSERT INTO known_students (name, subject, last_used_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET subject = excluded.subject, last_used_at = excluded.last_used_at
  `).run(cleanName, (subject || '').trim(), now);
}

app.get('/api/health', async (_req, res) => {
  try {
    // quick DB check
    if (pgPool) await pgPool.query('SELECT 1');
    else db.prepare('SELECT 1').get();
    res.json({ ok: true, message: 'Agenda escolar conectada' });
  } catch (e) {
    res.status(500).json({ ok: false, message: 'DB error', error: e.message });
  }
});

app.get('/api/day/:date', async (req, res) => {
  const date = normalizeDate(req.params.date);
  try {
    const day = await getDayData(date);
    res.json(day);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/day/:date', async (req, res) => {
  const date = normalizeDate(req.params.date);
  const payload = req.body || {};
  const data = payload.data || payload || { blocks: {} };
  const blocks = data.blocks || {};
  const now = new Date().toISOString();

  try {
    if (pgPool) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM students WHERE date = $1', [date]);
        const insertText = `INSERT INTO students (id, date, block_id, name, subject, notes, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
        for (const [blockId, students] of Object.entries(blocks)) {
          for (const student of (students || [])) {
            await client.query(insertText, [uid(), date, blockId, (student.name || '').trim(), (student.subject || '').trim(), (student.notes || '').trim(), now, now]);
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      const day = await getDayData(date);
      res.json({ success: true, date, day });
      return;
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM students WHERE date = ?').run(date);
      const insert = db.prepare(`
        INSERT INTO students (id, date, block_id, name, subject, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      Object.entries(blocks).forEach(([blockId, students]) => {
        (students || []).forEach((student) => {
          insert.run(uid(), date, blockId, (student.name || '').trim(), (student.subject || '').trim(), (student.notes || '').trim(), now, now);
        });
      });
    });
    tx();
    res.json({ success: true, date, day: await getDayData(date) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/agenda', async (req, res) => {
  try {
    const date = normalizeDate(req.query.date);
    const day = await getDayData(date);
    const known = await listKnownStudents();
    res.json({
      date,
      blocks: blockDefsForDate(date),
      day,
      known
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/known', async (_req, res) => {
  try {
    const known = await listKnownStudents();
    res.json({ known });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/known', async (req, res) => {
  const known = Array.isArray(req.body?.known) ? req.body.known : [];
  const now = new Date().toISOString();
  try {
    if (pgPool) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM known_students');
        const insertText = 'INSERT INTO known_students (name, subject, last_used_at) VALUES ($1,$2,$3)';
        for (const student of known) {
          await client.query(insertText, [(student.name || '').trim(), (student.subject || '').trim(), now]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      const list = await listKnownStudents();
      res.json({ success: true, known: list });
      return;
    }

    db.prepare('DELETE FROM known_students').run();
    const insert = db.prepare(`
      INSERT INTO known_students (name, subject, last_used_at)
      VALUES (?, ?, ?)
    `);

    known.forEach((student) => {
      insert.run((student.name || '').trim(), (student.subject || '').trim(), now);
    });

    res.json({ success: true, known: await listKnownStudents() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    const { date, blockId, name, subject, notes } = req.body || {};
    const safeDate = normalizeDate(date);
    const safeName = (name || '').trim();
    if (!safeName || !blockId) {
      return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    const day = await getDayData(safeDate);
    const currentBlock = day.blocks[blockId] || [];
    if (currentBlock.length >= 7) {
      return res.status(409).json({ error: 'Ese bloque ya tiene los 7 cupos ocupados.' });
    }

    const now = new Date().toISOString();
    const studentId = uid();

    if (pgPool) {
      await pgPool.query(`
        INSERT INTO students (id, date, block_id, name, subject, notes, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [studentId, safeDate, blockId, safeName, (subject || '').trim(), (notes || '').trim(), now, now]);

      await upsertKnownStudent(safeName, subject);
      const updatedDay = await getDayData(safeDate);
      const known = await listKnownStudents();
      res.json({ success: true, studentId, day: updatedDay, known });
      return;
    }

    db.prepare(`
      INSERT INTO students (id, date, block_id, name, subject, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(studentId, safeDate, blockId, safeName, (subject || '').trim(), (notes || '').trim(), now, now);

    await upsertKnownStudent(safeName, subject);

    res.json({
      success: true,
      studentId,
      day: await getDayData(safeDate),
      known: await listKnownStudents()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { date, blockId, name, subject, notes } = req.body || {};
    const safeDate = normalizeDate(date);
    const safeName = (name || '').trim();
    if (!safeName || !blockId) {
      return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    const now = new Date().toISOString();

    if (pgPool) {
      const result = await pgPool.query(`
        UPDATE students
        SET date = $1, block_id = $2, name = $3, subject = $4, notes = $5, updated_at = $6
        WHERE id = $7
      `, [safeDate, blockId, safeName, (subject || '').trim(), (notes || '').trim(), now, id]);

      if (result.rowCount === 0) return res.status(404).json({ error: 'Alumno no encontrado' });

      await upsertKnownStudent(safeName, subject);
      res.json({ success: true, day: await getDayData(safeDate), known: await listKnownStudents() });
      return;
    }

    const result = db.prepare(`
      UPDATE students
      SET date = ?, block_id = ?, name = ?, subject = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(safeDate, blockId, safeName, (subject || '').trim(), (notes || '').trim(), now, id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Alumno no encontrado' });
    }

    await upsertKnownStudent(safeName, subject);

    res.json({ success: true, day: await getDayData(safeDate), known: await listKnownStudents() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { date } = req.query;
    const safeDate = normalizeDate(date);

    if (pgPool) {
      const result = await pgPool.query('DELETE FROM students WHERE id = $1', [id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Alumno no encontrado' });
      res.json({ success: true, day: await getDayData(safeDate), known: await listKnownStudents() });
      return;
    }

    const result = db.prepare('DELETE FROM students WHERE id = ?').run(id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Alumno no encontrado' });
    }

    res.json({ success: true, day: await getDayData(safeDate), known: await listKnownStudents() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

if (require.main === module) {
  const server = app.listen(port, () => {
    console.log(`Agenda escolar escuchando en http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const fallbackPort = 3001;
      console.log(`Puerto ${port} ocupado. Intentando ${fallbackPort}...`);
      const fallbackServer = app.listen(fallbackPort, () => {
        console.log(`Agenda escolar escuchando en http://localhost:${fallbackPort}`);
      });
      fallbackServer.on('error', (fallbackErr) => {
        console.error('No se pudo iniciar el servidor:', fallbackErr);
        process.exit(1);
      });
    } else {
      console.error('No se pudo iniciar el servidor:', err);
      process.exit(1);
    }
  });
}

module.exports = app;
