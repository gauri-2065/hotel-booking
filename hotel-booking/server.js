const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

// ---------- Database (Rooms and Bookings tables) ----------
const db = new Database(path.join(__dirname, 'hotel.db'));
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  room_no TEXT NOT NULL UNIQUE,
  type    TEXT NOT NULL,
  price   REAL NOT NULL CHECK (price > 0),
  status  TEXT NOT NULL DEFAULT 'Available' CHECK (status IN ('Available','Maintenance'))
);
CREATE TABLE IF NOT EXISTS bookings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  guest_name TEXT NOT NULL,
  check_in   TEXT NOT NULL,
  check_out  TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);
if (db.prepare('SELECT COUNT(*) c FROM rooms').get().c === 0) {
  const ins = db.prepare('INSERT INTO rooms (room_no,type,price) VALUES (?,?,?)');
  [['101','Single',2500],['102','Single',2500],['201','Double',4000],
   ['202','Double',4200],['301','Deluxe',6500],['401','Suite',9500]].forEach(r => ins.run(...r));
}

// ---------- Helpers ----------
const TYPES = ['Single', 'Double', 'Deluxe', 'Suite'];
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s));
const today = () => new Date().toISOString().slice(0, 10);
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const wrap = fn => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };
// Two stays overlap when each starts before the other ends (check-out day is free).
const OVERLAP = 'b.room_id = r.id AND b.check_in < @out AND b.check_out > @in';

function checkDates(checkIn, checkOut) {
  if (!isDate(checkIn) || !isDate(checkOut)) throw new HttpError(400, 'Dates must be in YYYY-MM-DD format.');
  if (checkOut <= checkIn) throw new HttpError(400, 'Check-out must be after check-in.');
  if (checkIn < today()) throw new HttpError(400, 'Check-in cannot be in the past.');
}

// ---------- App + middleware ----------
const app = express();
app.use(express.json());
app.use((req, _res, next) => { console.log(`${req.method} ${req.url}`); next(); });
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Rooms ----------
app.get('/api/rooms', wrap((_req, res) => {
  res.json(db.prepare(`SELECT r.*, EXISTS(SELECT 1 FROM bookings b WHERE b.room_id = r.id
    AND b.check_in <= @t AND b.check_out > @t) AS booked_today FROM rooms r ORDER BY r.room_no`).all({ t: today() }));
}));

// Search available rooms by type and/or date range
app.get('/api/rooms/search', wrap((req, res) => {
  const { type, checkIn, checkOut } = req.query;
  if (type && !TYPES.includes(type)) throw new HttpError(400, 'Unknown room type.');
  let sql = `SELECT r.* FROM rooms r WHERE r.status = 'Available'`;
  const p = {};
  if (type) { sql += ' AND r.type = @type'; p.type = type; }
  if (checkIn || checkOut) {
    checkDates(checkIn, checkOut);
    sql += ` AND NOT EXISTS (SELECT 1 FROM bookings b WHERE ${OVERLAP})`;
    p.in = checkIn; p.out = checkOut;
  }
  res.json(db.prepare(sql + ' ORDER BY r.room_no').all(p));
}));

app.post('/api/rooms', wrap((req, res) => {
  const { roomNo, type, price } = req.body;
  if (!roomNo || !String(roomNo).trim()) throw new HttpError(400, 'Room number is required.');
  if (!TYPES.includes(type)) throw new HttpError(400, 'Choose a valid room type.');
  if (!(Number(price) > 0)) throw new HttpError(400, 'Price must be greater than 0.');
  try {
    const r = db.prepare('INSERT INTO rooms (room_no,type,price) VALUES (?,?,?)').run(String(roomNo).trim(), type, Number(price));
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, `Room ${roomNo} already exists.`);
    throw e;
  }
}));

app.put('/api/rooms/:id', wrap((req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) throw new HttpError(404, 'Room not found.');
  const type = req.body.type ?? room.type, price = Number(req.body.price ?? room.price), status = req.body.status ?? room.status;
  if (!TYPES.includes(type) || !(price > 0) || !['Available', 'Maintenance'].includes(status)) throw new HttpError(400, 'Invalid room data.');
  db.prepare('UPDATE rooms SET type=?, price=?, status=? WHERE id=?').run(type, price, status, room.id);
  res.json({ ok: true });
}));

app.delete('/api/rooms/:id', wrap((req, res) => {
  const r = db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
  if (!r.changes) throw new HttpError(404, 'Room not found.');
  res.json({ ok: true });
}));

// ---------- Bookings ----------
app.get('/api/bookings', wrap((_req, res) => {
  res.json(db.prepare(`SELECT b.*, r.room_no, r.type, r.price FROM bookings b
    JOIN rooms r ON r.id = b.room_id ORDER BY b.check_in`).all());
}));

app.post('/api/bookings', wrap((req, res) => {
  const { roomId, guestName, checkIn, checkOut } = req.body;
  if (!guestName || !String(guestName).trim()) throw new HttpError(400, 'Guest name is required.');
  checkDates(checkIn, checkOut);
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) throw new HttpError(404, 'Room not found.');
  if (room.status !== 'Available') throw new HttpError(409, `Room ${room.room_no} is under maintenance.`);
  const clash = db.prepare(`SELECT b.* FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE ${OVERLAP} AND r.id = @id`)
    .get({ id: room.id, in: checkIn, out: checkOut });
  if (clash) throw new HttpError(409, `Room ${room.room_no} is already booked from ${clash.check_in} to ${clash.check_out}.`);
  const r = db.prepare('INSERT INTO bookings (room_id,guest_name,check_in,check_out) VALUES (?,?,?,?)')
    .run(room.id, String(guestName).trim(), checkIn, checkOut);
  res.status(201).json({ id: r.lastInsertRowid });
}));

app.delete('/api/bookings/:id', wrap((req, res) => {
  const r = db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  if (!r.changes) throw new HttpError(404, 'Booking not found. It may already be cancelled.');
  res.json({ ok: true });
}));

// ---------- Errors ----------
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unknown API route.')));
app.use((err, _req, res, _next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.code || 500).json({ error: err.code ? err.message : 'Server error.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hotel booking running at http://localhost:${PORT}`));
