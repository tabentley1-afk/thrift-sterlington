
const Database = require('better-sqlite3');
const path = require('path');

const dbFile = path.join(__dirname, 'data.sqlite');
const db = new Database(dbFile);

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donor_name TEXT,
      donor_email TEXT,
      donor_phone TEXT,
      pickup_address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      categories TEXT,
      condition TEXT,
      item_notes TEXT,
      preferred_date TEXT,
      preferred_time TEXT,
      bags_count INTEGER DEFAULT 0,
      furniture_count INTEGER DEFAULT 0,
      small_donation INTEGER DEFAULT 0,
      crew_size INTEGER DEFAULT 1,
      estimated_miles REAL DEFAULT 0,
      drive_minutes REAL DEFAULT 0,
      onsite_minutes REAL DEFAULT 0,
      fuel_cost_per_mile REAL DEFAULT 0.2,
      estimated_cost REAL DEFAULT 0,
      images_json TEXT,
      status TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER,
      start_iso TEXT,
      end_iso TEXT
    );
    CREATE TABLE IF NOT EXISTS blackout_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE
    );
  `);
}

function insertTicket(t) {
  const stmt = db.prepare(`INSERT INTO tickets 
    (donor_name, donor_email, donor_phone, pickup_address, city, state, zip, categories, condition, item_notes, preferred_date, preferred_time, bags_count, furniture_count, small_donation, crew_size, estimated_miles, drive_minutes, onsite_minutes, fuel_cost_per_mile, estimated_cost, images_json, status, created_at)
    VALUES (@donor_name, @donor_email, @donor_phone, @pickup_address, @city, @state, @zip, @categories, @condition, @item_notes, @preferred_date, @preferred_time, @bags_count, @furniture_count, @small_donation, @crew_size, @estimated_miles, @drive_minutes, @onsite_minutes, @fuel_cost_per_mile, @estimated_cost, @images_json, @status, @created_at)`);
  return stmt.run(t).lastInsertRowid;
}

function listTickets() { return db.prepare('SELECT * FROM tickets ORDER BY created_at DESC').all(); }
function getTicket(id) { return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id); }
function updateStatus(id, status) { return db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(status, id); }
function scheduleTicket(ticket_id, start_iso, end_iso) {
  db.prepare('INSERT INTO schedules (ticket_id, start_iso, end_iso) VALUES (?,?,?)').run(ticket_id, start_iso, end_iso);
  db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run('scheduled', ticket_id);
}
function updateSchedule(id, start_iso, end_iso) { db.prepare('UPDATE schedules SET start_iso = ?, end_iso = ? WHERE id = ?').run(start_iso, end_iso, id); }
function listScheduled() {
  return db.prepare(`SELECT schedules.*, tickets.donor_name, tickets.pickup_address 
                     FROM schedules JOIN tickets ON tickets.id = schedules.ticket_id
                     ORDER BY start_iso ASC`).all();
}
function findConflicts(start_iso, end_iso) {
  return db.prepare(`SELECT * FROM schedules WHERE NOT (end_iso <= ? OR start_iso >= ?)`)
           .all(start_iso, end_iso);
}
function updateTicketMiles(id, miles){ db.prepare('UPDATE tickets SET estimated_miles = ? WHERE id = ?').run(miles, id); }
function updateCrewSize(id, crew){ db.prepare('UPDATE tickets SET crew_size = ? WHERE id = ?').run(crew, id); }
function updateTimesAndCost(id, driveMin, onsiteMin, hourly, crew, fuelPerMile, miles){
  const labor = ((driveMin + onsiteMin)/60.0) * hourly * crew;
  const fuel = (miles||0) * fuelPerMile;
  const total = +(labor + fuel).toFixed(2);
  db.prepare('UPDATE tickets SET drive_minutes=?, onsite_minutes=?, fuel_cost_per_mile=?, estimated_cost=? WHERE id=?')
    .run(driveMin, onsiteMin, fuelPerMile, total, id);
  return { labor, fuel, total };
}

// Blackout helpers
function listBlackouts(){ return db.prepare('SELECT * FROM blackout_days ORDER BY date').all(); }
function addBlackout(date){ try { db.prepare('INSERT INTO blackout_days (date) VALUES (?)').run(date); } catch(e) {} }
function deleteBlackout(id){ db.prepare('DELETE FROM blackout_days WHERE id = ?').run(id); }
function isBlackout(date){ const r = db.prepare('SELECT id FROM blackout_days WHERE date = ?').get(date); return !!r; }

module.exports = { init, insertTicket, listTickets, getTicket, updateStatus, scheduleTicket, listScheduled, findConflicts, updateSchedule, updateTicketMiles, updateCrewSize, updateTimesAndCost, listBlackouts, addBlackout, deleteBlackout, isBlackout };

if (require.main === module) {
  if (process.argv[2] === 'init') { init(); console.log('DB initialized at', dbFile); }
}
