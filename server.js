
require('dotenv').config();
process.env.TZ = process.env.TZ || 'America/Chicago';
const express = require('express');
const path = require('path');
const multer = require('multer');
const helmet = require('helmet');
const morgan = require('morgan');
const session = require('express-session');
const fs = require('fs');
const { DateTime } = require('luxon');
const db = require('./db');
const engine = require('ejs-mate');

const app = express();
const PORT = process.env.PORT || 3000;
const CT_ZONE = 'America/Chicago';

app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(helmet());
app.use(morgan('dev'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({ secret: process.env.SESSION_SECRET || 'thrift-secret', resave: false, saveUninitialized: false }));

function requireAdmin(req, res, next) { if (req.session?.isAdmin) return next(); return res.redirect('/admin'); }

// File uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + '-' + file.originalname.replace(/\s+/g,'_'))
});
const upload = multer({ storage });

// Utils
async function getMilesBetween(origin, destination) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY missing');
  const params = new URLSearchParams({ origins: origin, destinations: destination, key, units: 'imperial' });
  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json?' + params.toString();
  const r = await fetch(url);
  if (!r.ok) throw new Error('distance api http ' + r.status);
  const data = await r.json();
  const row = data.rows?.[0]?.elements?.[0];
  if (!row || row.status !== 'OK') throw new Error('distance api: ' + (row?.status || 'no result'));
  return (row.distance.value / 1609.344);
}
function suggestCrewSize({bags=0, furniture=0, small=0}) {
  if (small) return 1;
  if (furniture >= 1) return 2;
  if (bags >= 8) return 2;
  return 1;
}
function validateBusinessHoursCT(start, end) {
  const s = start.setZone(CT_ZONE);
  const e = end.setZone(CT_ZONE);
  const sHour = s.hour + s.minute/60;
  const eHour = e.hour + e.minute/60;
  if (db.isBlackout(s.toISODate())) return { ok:false, msg:`Closed on ${s.toISODate()}` };
  if (sHour < 9.5) return { ok:false, msg:'Start must be at or after 9:30 AM CT.' };
  if (eHour > 17) return { ok:false, msg:'End must be at or before 5:00 PM CT.' };
  return { ok:true };
}

// Home
app.get('/', (req, res) => res.redirect('/donate'));

// Donor form (no cost section)
app.get('/donate', (req, res) => {
  res.render('donor_form');
});

// Create ticket
app.post('/tickets', upload.array('item_images', 10), (req, res) => {
  const b = req.body;
  const files = (req.files || []).map(f => f.filename);
  const bags = parseInt(b.bags_count||0)||0;
  const furn = parseInt(b.furniture_count||0)||0;
  const small = b.small_donation ? 1 : 0;

  const ticket = {
    donor_name: b.donor_name, donor_email: b.donor_email, donor_phone: b.donor_phone,
    pickup_address: b.pickup_address, city: b.city, state: b.state, zip: b.zip,
    categories: JSON.stringify(b.categories || []), condition: b.condition, item_notes: b.item_notes,
    preferred_date: b.preferred_date || null, preferred_time: b.preferred_time || null,
    bags_count: bags, furniture_count: furn, small_donation: small,
    crew_size: 1, estimated_miles: 0, drive_minutes: 0, onsite_minutes: 0,
    fuel_cost_per_mile: parseFloat(process.env.FUEL_COST_PER_MILE||0.2),
    estimated_cost: 0, images_json: JSON.stringify(files),
    status: 'new', created_at: DateTime.now().setZone(CT_ZONE).toISO()
  };

  const id = db.insertTicket(ticket);

  const outboxDir = path.join(__dirname, 'outbox'); if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir);
  fs.writeFileSync(path.join(outboxDir, `staff-new-${id}.txt`), `New pickup request #${id} from ${ticket.donor_name}`);
  fs.writeFileSync(path.join(outboxDir, `donor-new-${id}.txt`), `Thanks ${ticket.donor_name}! Your pickup request #${id} was received.`);

  res.render('thank_you', { id, ticket });
});

// Admin login
app.get('/admin', (req, res) => { if (req.session?.isAdmin) return res.redirect('/admin/tickets'); res.render('admin_login', { err: null }); });
app.post('/admin', (req, res) => {
  const secret = req.body.secret;
  if (secret === (process.env.ADMIN_SECRET||'password')) { req.session.isAdmin = true; return res.redirect('/admin/tickets'); }
  res.render('admin_login', { err: 'Invalid secret' });
});
app.get('/admin/logout', (req,res)=>{ req.session.destroy(()=>res.redirect('/admin')); });

// Admin tickets list
app.get('/admin/tickets', requireAdmin, (req, res) => {
  const tickets = db.listTickets();
  res.render('admin_list', { tickets, CT_ZONE });
});

// Ticket detail
app.get('/admin/tickets/:id', requireAdmin, (req, res) => {
  const t = db.getTicket(req.params.id);
  if (!t) return res.status(404).send('Not found');
  res.render('ticket_detail', { t, CT_ZONE });
});

// Update status
app.post('/admin/tickets/:id/status', requireAdmin, (req, res) => {
  const valid = new Set(['new','scheduled','completed','canceled']);
  const status = String(req.body.status||'').toLowerCase();
  if (!valid.has(status)) return res.status(400).send('Invalid status');
  db.updateStatus(req.params.id, status);
  res.redirect('/admin/tickets/' + req.params.id);
});

// Admin: update time inputs + recompute costs
app.post('/admin/tickets/:id/timecost', requireAdmin, (req, res) => {
  const t = db.getTicket(req.params.id);
  if (!t) return res.status(404).send('Ticket not found');
  const drive = parseFloat(req.body.drive_minutes||0)||0;
  const onsite = parseFloat(req.body.onsite_minutes||0)||0;
  const hourly = parseFloat(process.env.EMPLOYEE_HOURLY||10);
  const crew = parseInt(req.body.crew_size||t.crew_size||1);
  const fuelPerMile = parseFloat(req.body.fuel_cost_per_mile||t.fuel_cost_per_mile||0.2);
  const miles = parseFloat(t.estimated_miles||0)||0;
  db.updateCrewSize(t.id, crew);
  db.updateTimesAndCost(t.id, drive, onsite, hourly, crew, fuelPerMile, miles);
  res.redirect('/admin/tickets/' + t.id);
});

// Recalc mileage + auto crew
app.post('/admin/tickets/:id/recalc', requireAdmin, async (req, res) => {
  const t = db.getTicket(req.params.id);
  if (!t) return res.status(404).send('Ticket not found');
  const ORIGIN = '10010 US-165, Sterlington, LA 71280';
  const dest = [t.pickup_address, t.city, t.state, t.zip].filter(Boolean).join(', ');
  try {
    const milesOneWay = await getMilesBetween(ORIGIN, dest);
    const roundTrip = +(milesOneWay * 2).toFixed(1);
    db.updateTicketMiles(t.id, roundTrip);
  } catch (e) { console.error('distance error', e); }
  const bags = parseInt(t.bags_count||0)||0;
  const furn = parseInt(t.furniture_count||0)||0;
  const small = parseInt(t.small_donation||0)||0;
  const crew = suggestCrewSize({bags, furniture:furn, small});
  db.updateCrewSize(t.id, crew);
  const hourly = parseFloat(process.env.EMPLOYEE_HOURLY||10);
  db.updateTimesAndCost(t.id, t.drive_minutes||0, t.onsite_minutes||0, hourly, crew, t.fuel_cost_per_mile||0.2, (t.estimated_miles||0));
  res.redirect('/admin/tickets/' + t.id);
});

// Availability (admin only): list + calendar
app.get('/admin/availability', requireAdmin, (req, res) => {
  const events = db.listScheduled();
  res.render('availability', { events, CT_ZONE });
});

// Calendar page
app.get('/admin/calendar', requireAdmin, (req, res) => { res.render('admin_calendar'); });

// JSON for calendar
app.get('/api/schedule', requireAdmin, (req, res) => {
  const events = db.listScheduled().map(e => ({
    id: e.id,
    title: `#${e.ticket_id} - ${e.donor_name}`,
    start: e.start_iso,
    end: e.end_iso
  }));
  res.json(events);
});

// Blackout management
app.get('/admin/blackouts', requireAdmin, (req, res) => {
  const days = db.listBlackouts();
  res.render('admin_blackouts', { days, CT_ZONE });
});
app.post('/admin/blackouts', requireAdmin, (req, res) => {
  const date = String(req.body.date||'').trim();
  if (date) db.addBlackout(date);
  res.redirect('/admin/blackouts');
});
app.post('/admin/blackouts/:id/delete', requireAdmin, (req, res) => {
  db.deleteBlackout(req.params.id);
  res.redirect('/admin/blackouts');
});
app.get('/api/blackouts', requireAdmin, (req, res) => {
  const days = db.listBlackouts();
  const events = days.map(d => ({
    start: d.date,
    end: DateTime.fromISO(d.date).plus({ days: 1 }).toISODate(),
    display: 'background',
    backgroundColor: '#ffd6d6'
  }));
  res.json(events);
});

// Schedule a ticket (validate CT business hours and blackouts)
app.post('/admin/tickets/:id/schedule', requireAdmin, (req, res) => {
  const id = req.params.id;
  const start = DateTime.fromISO(req.body.start_iso, { zone: CT_ZONE });
  const durationHours = parseFloat(req.body.duration_hours||1);
  const end = start.plus({ hours: durationHours });
  const business = validateBusinessHoursCT(start, end);
  if (!business.ok) return res.status(400).send(business.msg);
  const conflicts = db.findConflicts(start.toISO(), end.toISO());
  if (conflicts.length) return res.status(400).send('Conflict with existing schedule.');
  db.scheduleTicket(id, start.toISO(), end.toISO());
  res.redirect('/admin/tickets');
});

// Drag/drop/resizes
app.post('/admin/schedule/:id/move', requireAdmin, (req, res) => {
  const id = req.params.id;
  const start = DateTime.fromISO(req.body.start_iso, { zone: CT_ZONE });
  const end = DateTime.fromISO(req.body.end_iso, { zone: CT_ZONE });
  const business = validateBusinessHoursCT(start, end);
  if (!business.ok) return res.status(409).json({ error: business.msg });
  const conflicts = db.findConflicts(start.toISO(), end.toISO()).filter(e => String(e.id) !== String(id));
  if (conflicts.length) return res.status(409).json({ error: 'Conflict' });
  db.updateSchedule(id, start.toISO(), end.toISO());
  res.json({ ok: true });
});

// CSV export
app.get('/admin/export.csv', requireAdmin, (req, res) => {
  const rows = db.listTickets();
  const headers = ['id','created_at','status','donor_name','donor_email','donor_phone','pickup_address','city','state','zip','categories','condition','item_notes','preferred_date','preferred_time','bags_count','furniture_count','small_donation','crew_size','estimated_miles','drive_minutes','onsite_minutes','fuel_cost_per_mile','estimated_cost'];
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="tickets.csv"');
  res.write(headers.join(',')+'\n');
  for (const r of rows) {
    const vals = headers.map(h => {
      let v = r[h];
      if (h==='categories' && typeof v === 'string') { try { v = JSON.parse(v).join('|'); } catch {} }
      if (typeof v === 'string') v = `"${v.replace(/"/g,'""')}"`;
      return v ?? '';
    });
    res.write(vals.join(',')+'\n');
  }
  res.end();
});

app.listen(PORT, () => { db.init(); console.log(`Server running on http://localhost:${PORT}`); });
