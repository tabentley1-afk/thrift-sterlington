// db.js — SQLite (better-sqlite3) thin wrapper for thrift pickups
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'data.sqlite');

let db;

// ---------- init & schema ----------
function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT,
      status TEXT DEFAULT 'new',
      donor_name TEXT,
      donor_email TEXT,
      donor_phone TEXT,
      pickup_address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      categories TEXT,             -- JSON array
      condition TEXT,
      item_notes TEXT,
      preferred_date TEXT,
      preferred_time TEXT,
      bags_count INTEGER DEFAULT 0,
      furniture_count INTEGER DEFAULT 0,
      small_donation INTEGER DEFAULT 0,
      crew_size INTEGER DEFAULT 1,
      estimated_miles REAL DEFAULT 0,  -- round trip
      drive_minutes REAL DEFAULT 0,    -- round trip
      onsite_minutes REAL DEFAULT 0,
      fuel_cost_per_mile REAL DEFAULT 0.2,
      estimated_cost REAL DEFAULT 0,
      images_json TEXT               -- JSON array of filenames
    );

    CREATE TABLE IF NOT EXISTS schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER,
      donor_name TEXT,
      start_iso TEXT,
      end_iso TEXT,
      FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_time ON schedule(start_iso, end_iso);

    CREATE TABLE IF NOT EXISTS blackouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE -- ISO date YYYY-MM-DD
    );
  `);
}

// ---------- ticket CRUD ----------
function insertTicket(t) {
  const stmt = db.prepare(`
    INSERT INTO tickets (
      created_at,status,donor_name,donor_email,donor_phone,
      pickup_address,city,state,zip,
      categories,condition,item_notes,
      preferred_date,preferred_time,
      bags_count,furniture_count,small_donation,
      crew_size,estimated_miles,drive_minutes,onsite_minutes,
      fuel_cost_per_mile,estimated_cost,images_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const info = stmt.run(
    t.created_at, t.status, t.donor_name, t.donor_email, t.donor_phone,
    t.pickup_address, t.city, t.state, t.zip,
    t.categories, t.condition, t.item_notes,
    t.preferred_date, t.preferred_time,
    t.bags_count, t.furniture_count, t.small_donation,
    t.crew_size, t.estimated_miles, t.drive_minutes, t.onsite_minutes,
    t.fuel_cost_per_mile, t.estimated_cost, t.images_json
  );
  return info.lastInsertRowid;
}

function listTickets() {
  return db.prepare(`SELECT * FROM tickets ORDER BY id DESC`).all();
}

function getTicket(id) {
  return db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id);
}

function updateTicketMiles(id, milesRT) {
  db.prepare(`UPDATE tickets SET estimated_miles = ? WHERE id = ?`).run(milesRT, id);
}

function updateCrewSize(id, crew) {
  db.prepare(`UPDATE tickets SET crew_size = ? WHERE id = ?`).run(crew, id);
}

function updateTimesAndCost(id, driveMinutes, onsiteMinutes, hourly, crew, fuelPerMile, milesRT) {
  const laborHours = (Number(driveMinutes||0) + Number(onsiteMinutes||0)) / 60;
  const laborCost = laborHours * Number(hourly||0) * Number(crew||1);
  const fuelCost = Number(milesRT||0) * Number(fuelPerMile||0);
  const total = laborCost + fuelCost;
  db.prepare(`
    UPDATE tickets
       SET drive_minutes = ?, onsite_minutes = ?, fuel_cost_per_mile = ?, estimated_cost = ?
     WHERE id = ?
  `).run(driveMinutes, onsiteMinutes, fuelPerMile, total, id);
}

function updateStatus(id, status) {
  db.prepare(`UPDATE tickets SET status = ? WHERE id = ?`).run(status, id);
}

// ---------- schedule ----------
function scheduleTicket(ticketId, startISO, endISO) {
  const t = getTicket(ticketId);
  if (!t) return;
  db.prepare(`
    INSERT INTO schedule (ticket_id, donor_name, start_iso, end_iso)
    VALUES (?, ?, ?, ?)
  `).run(ticketId, t.donor_name || `#${ticketId}`, startISO, endISO);
}

function listScheduled() {
  return db.prepare(`SELECT * FROM schedule ORDER BY start_iso ASC`).all();
}

function findConflicts(startISO, endISO) {
  return db.prepare(`
    SELECT * FROM schedule
     WHERE NOT (end_iso <= ? OR start_iso >= ?)
  `).all(startISO, endISO);
}

function updateSchedule(id, startISO, endISO) {
  db.prepare(`UPDATE schedule SET start_iso = ?, end_iso = ? WHERE id = ?`).run(startISO, endISO, id);
}

function unscheduleTicketByTicketId(ticketId){
  db.prepare(`DELETE FROM schedule WHERE ticket_id = ?`).run(ticketId);
}

// ---------- blackouts ----------
function addBlackout(dateISO) {
  db.prepare(`INSERT OR IGNORE INTO blackouts (date) VALUES (?)`).run(dateISO);
}

function listBlackouts() {
  return db.prepare(`SELECT * FROM blackouts ORDER BY date ASC`).all();
}

function deleteBlackout(id) {
  db.prepare(`DELETE FROM blackouts WHERE id = ?`).run(id);
}

function isBlackout(dateISO) {
  const row = db.prepare(`SELECT 1 FROM blackouts WHERE date = ?`).get(dateISO);
  return !!row;
}

// ---------- delete ----------
function deleteTicket(id) {
  // schedule rows removed by FK cascade, but call safe remove in case FK is off
  unscheduleTicketByTicketId(id);
  db.prepare(`DELETE FROM tickets WHERE id = ?`).run(id);
}

// ---------- exports ----------
module.exports = {
  init,
  insertTicket,
  listTickets,
  getTicket,
  updateTicketMiles,
  updateCrewSize,
  updateTimesAndCost,
  updateStatus,
  scheduleTicket,
  listScheduled,
  findConflicts,
  updateSchedule,
  addBlackout,
  listBlackouts,
  deleteBlackout,
  isBlackout,
  deleteTicket,
  unscheduleTicketByTicketId
};
