const path = require('path');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@tursodatabase/serverless/compat');

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.TURSO_DATABASE_URL) {
  console.error('TURSO_DATABASE_URL must be set.');
  process.exit(1);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function ensureSchema() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      block_id TEXT NOT NULL,
      name TEXT NOT NULL,
      subject TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS known_students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      subject TEXT,
      last_used_at TEXT NOT NULL
    )`
  ], 'exclusive');
}

ensureSchema().catch((error) => {
  console.error('Error initializing Turso database schema:', error);
  process.exit(1);
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'agenda-apoyo-escolar.html'));
});

app.get('/agenda-apoyo-escolar.html', (_req, res) => {
  res.sendFile(path.join(__dirname, 'agenda-apoyo-escolar.html'));
});

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

function rowToObject(columns, row) {
  const obj = {};
  (columns || []).forEach((col, index) => {
    obj[col.name] = row[index];
  });
  return obj;
}

function mapRows(result) {
  const columns = result.columns || [];
  const rows = result.rows || [];
  return rows.map((row) => rowToObject(columns, row));
}

async function getDayData(date) {
  const result = await db.execute(
    'SELECT id, date, block_id, name, subject, notes, created_at, updated_at FROM students WHERE date = ? ORDER BY created_at ASC',
    [date]
  );
  const rows = mapRows(result);
  const blocks = {};
  rows.forEach((row) => {
    if (!blocks[row.block_id]) blocks[row.block_id] = [];
    blocks[row.block_id].push({
      id: row.id,
      name: row.name,
      subject: row.subject,
      notes: row.notes
    });
  });
  return { date, blocks };
}

async function listKnownStudents() {
  const result = await db.execute(
    'SELECT name, subject FROM known_students ORDER BY last_used_at DESC LIMIT 80',
    []
  );
  return mapRows(result).map((row) => ({ name: row.name, subject: row.subject || '' }));
}

async function upsertKnownStudent(name, subject) {
  const cleanName = (name || '').trim();
  if (!cleanName) return;
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO known_students (name, subject, last_used_at)
     VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET subject = excluded.subject, last_used_at = excluded.last_used_at`,
    [cleanName, (subject || '').trim(), now]
  );
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, message: 'Agenda escolar conectada' });
});

app.get('/api/day/:date', async (req, res) => {
  try {
    const date = normalizeDate(req.params.date);
    res.json(await getDayData(date));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener el día' });
  }
});

app.put('/api/day/:date', async (req, res) => {
  try {
    const date = normalizeDate(req.params.date);
    const payload = req.body || {};
    const data = payload.data || payload || { blocks: {} };
    const blocks = data.blocks || {};
    const now = new Date().toISOString();

    const statements = [{ sql: 'DELETE FROM students WHERE date = ?', args: [date] }];
    Object.entries(blocks).forEach(([blockId, students]) => {
      (students || []).forEach((student) => {
        statements.push({
          sql: 'INSERT INTO students (id, date, block_id, name, subject, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          args: [
            uid(),
            date,
            blockId,
            (student.name || '').trim(),
            (student.subject || '').trim(),
            (student.notes || '').trim(),
            now,
            now
          ]
        });
      });
    });

    await db.batch(statements, 'exclusive');
    res.json({ success: true, date, day: await getDayData(date) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al guardar el día' });
  }
});

app.get('/api/agenda', async (req, res) => {
  try {
    const date = normalizeDate(req.query.date);
    const day = await getDayData(date);
    res.json({
      date,
      blocks: blockDefsForDate(date),
      day,
      known: await listKnownStudents()
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener la agenda' });
  }
});

app.get('/api/known', async (_req, res) => {
  try {
    res.json({ known: await listKnownStudents() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener alumnos conocidos' });
  }
});

app.put('/api/known', async (req, res) => {
  try {
    const known = Array.isArray(req.body?.known) ? req.body.known : [];
    const now = new Date().toISOString();
    const statements = [{ sql: 'DELETE FROM known_students', args: [] }];

    known.forEach((student) => {
      statements.push({
        sql: 'INSERT INTO known_students (name, subject, last_used_at) VALUES (?, ?, ?)',
        args: [
          (student.name || '').trim(),
          (student.subject || '').trim(),
          now
        ]
      });
    });

    await db.batch(statements, 'exclusive');
    res.json({ success: true, known: await listKnownStudents() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar conocidos' });
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
    await db.execute(
      'INSERT INTO students (id, date, block_id, name, subject, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        studentId,
        safeDate,
        blockId,
        safeName,
        (subject || '').trim(),
        (notes || '').trim(),
        now,
        now
      ]
    );

    await upsertKnownStudent(safeName, subject);

    res.json({
      success: true,
      studentId,
      day: await getDayData(safeDate),
      known: await listKnownStudents()
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear el alumno' });
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
    const result = await db.execute(
      'UPDATE students SET date = ?, block_id = ?, name = ?, subject = ?, notes = ?, updated_at = ? WHERE id = ?',
      [
        safeDate,
        blockId,
        safeName,
        (subject || '').trim(),
        (notes || '').trim(),
        now,
        id
      ]
    );

    const changes = result.rowsAffected ?? result.affected_row_count ?? 0;
    if (!changes) {
      return res.status(404).json({ error: 'Alumno no encontrado' });
    }

    await upsertKnownStudent(safeName, subject);

    res.json({
      success: true,
      day: await getDayData(safeDate),
      known: await listKnownStudents()
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar el alumno' });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { date } = req.query;
    const safeDate = normalizeDate(date);
    const result = await db.execute('DELETE FROM students WHERE id = ?', [id]);
    const changes = result.rowsAffected ?? result.affected_row_count ?? 0;
    if (!changes) {
      return res.status(404).json({ error: 'Alumno no encontrado' });
    }

    res.json({
      success: true,
      day: await getDayData(safeDate),
      known: await listKnownStudents()
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al borrar el alumno' });
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
