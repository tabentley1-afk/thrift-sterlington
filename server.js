require('dotenv').config();
process.env.TZ = process.env.TZ || 'America/Chicago';

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const morgan = require('morgan');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const { DateTime } = require('luxon');
const engine = require('ejs-mate');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const CT_ZONE = 'America/Chicago';

app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(morgan('dev'));

const uploadBase = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(uploadBase, { recursive: true });
app.use('/uploads', express.static(uploadBase));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'thrift-secret',
  resave: false,
  saveUninitialized: false
}));
function requireAdmin(req,res,next){ if (req.session?.isAdmin) return next(); res.redirect('/admin'); }

const storage = multer.diskStorage({
  destination: (req,file,cb)=>cb(null, uploadBase),
  filename: (req,file,cb)=>cb(null, Date.now()+'-'+Math.round(Math.random()*1e9)+'-'+file.originalname.replace(/\s+/g,'_'))
});
const upload = multer({ storage });

// Distance helper (one-way values)
async function getDistance(origin, destination) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY missing');
  const params = new URLSearchParams({ origins: origin, destinations: destination, key, units: 'imperial' });
  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json?' + params.toString();
  const r = await fetch(url);
  if (!r.ok) throw new Error('distance api http ' + r.status);
  const data = await r.json();
  const row = data.rows?.[0]?.elements?.[0];
  if (!row || row.status !== 'OK') throw new Error('distance api: ' + (row?.status || 'no result'));
  const milesOneWay = row.distance.value / 1609.344;
  const minutesOneWay = row.duration.value / 60;
  return { milesOneWay, minutesOneWay };
}
function suggestCrewSize({bags=0, furniture=0, small=0}){
  if (small) return 1;
  if (furniture >= 1) return 2;
  if (bags >= 8) return 2;
  return 1;
}
function validateBusinessHoursCT(start, end){
  const s = start.setZone(CT_ZONE);
  const e = end.setZone(CT_ZONE);
  const sHour = s.hour + s.minute/60;
  const eHour = e.hour + e.minute/60;
  if (db.isBlackout(s.toISODate())) return { ok:false, msg:`Closed on ${s.toISODate()}` };
  if (sHour < 9.5) return { ok:false, msg:'Start must be at or after 9:30 AM CT.' };
  if (eHour > 17) return { ok:false, msg:'End must be at or before 5:00 PM CT.' };
  return { ok:true };
}

// ----- Public -----
app.get('/', (req,res)=>res.redirect('/donate'));
app.get('/donate', (req,res)=>res.render('donor_form'));

// Create ticket (images + required validation + categories fix)
app.post('/tickets', upload.array('item_images', 10), (req, res) => {
  const b = req.body;

  // categories can be string or array; require at least one
  let cats = b.categories;
  if (!Array.isArray(cats)) cats = cats ? [cats] : [];
  if (cats.length === 0) return res.status(400).send('Please select at least one item category.');

  // Required fields
  const required = {
    donor_name: 'Name',
    donor_email: 'Email',
    donor_phone: 'Phone',
    pickup_address: 'Address',
    city: 'City',
    state: 'State',
    zip: 'ZIP',
    item_notes: 'Short description / notes',
    preferred_date: 'Preferred date',
    preferred_time: 'Preferred time'
  };
  for (const k in required) {
    if (!b[k] || String(b[k]).trim() === '') {
      return res.status(400).send(`Missing required field: ${required[k]}`);
    }
  }

  const state = String(b.state || '').toUpperCase().slice(0,2);
  const zip   = String(b.zip || '').slice(0,5);
  const files = (req.files || []).map(f => f.filename);

  const ticket = {
    donor_name: b.donor_name.trim(),
    donor_email: b.donor_email.trim(),
    donor_phone: b.donor_phone.trim(),
    pickup_address: b.pickup_address.trim(),
    city: b.city.trim(),
    state,
    zip,
    categories: JSON.stringify(cats),
    condition: b.condition || 'Good',
    item_notes: b.item_notes.trim(),
    preferred_date: b.preferred_date,
    preferred_time: b.preferred_time,
    bags_count: parseInt(b.bags_count || 0) || 0,
    furniture_count: parseInt(b.furniture_count || 0) || 0,
    small_donation: b.small_donation ? 1 : 0,
    crew_size: 1,
    estimated_miles: 0,
    drive_minutes: 0,
    onsite_minutes: 0,
    fuel_cost_per_mile: parseFloat(process.env.FUEL_COST_PER_MILE || 0.2),
    estimated_cost: 0,
    images_json: JSON.stringify(files),
    status: 'new',
    created_at: DateTime.now().setZone(CT_ZONE).toISO()
  };

  const id = db.insertTicket(ticket);
  res.render('thank_you', { id, ticket });
});

// ----- Admin -----
app.get('/admin', (req,res)=>{ if (req.session?.isAdmin) return res.redirect('/admin/tickets'); res.render('admin_login', { err:null }); });
app.post('/admin', (req,res)=>{
  if ((req.body.secret||'') === (process.env.ADMIN_SECRET||'password')) { req.session.isAdmin = true; return res.redirect('/admin/tickets'); }
  res.render('admin_login', { err:'Invalid secret' });
});
app.get('/admin/logout', (req,res)=>{ req.session.destroy(()=>res.redirect('/admin')); });

app.get('/admin/tickets', requireAdmin, (req,res)=>{
  const tickets = db.listTickets();
  res.render('admin_list', { tickets, CT_ZONE });
});

// Auto-recalc miles & drive time on open
app.get('/admin/tickets/:id', requireAdmin, (req, res) => {
  (async () => {
    const t0 = db.getTicket(req.params.id);
    if (!t0) return res.status(404).send('Not found');

    const ORIGIN = '10010 US-165, Sterlington, LA 71280';
    const dest = [t0.pickup_address, t0.city, t0.state, t0.zip].filter(Boolean).join(', ');
    let milesRT = Number(t0.estimated_miles || 0);
    let driveMinRT = Number(t0.drive_minutes || 0);
    try{
      const { milesOneWay, minutesOneWay } = await getDistance(ORIGIN, dest);
      milesRT = +(milesOneWay * 2).toFixed(1);
      driveMinRT = Math.round(minutesOneWay * 2);
      db.updateTicketMiles(t0.id, milesRT);
    }catch(e){ console.error('auto-recalc distance error', e); }

    const crew = suggestCrewSize({
      bags: parseInt(t0.bags_count||0)||0,
      furniture: parseInt(t0.furniture_count||0)||0,
      small: parseInt(t0.small_donation||0)||0
    });
    db.updateCrewSize(t0.id, crew);
    const hourly = parseFloat(process.env.EMPLOYEE_HOURLY||10);
    const fuelPerMile = parseFloat(t0.fuel_cost_per_mile||0.2);
    db.updateTimesAndCost(t0.id, driveMinRT, 0, hourly, crew, fuelPerMile, milesRT);

    const t = db.getTicket(req.params.id);
    function safeArrayJSON(x){ if(!x) return []; try{ return Array.isArray(x)?x:JSON.parse(x);}catch{ return String(x).split(',').map(s => s.trim()).filter(Boolean);} }
    const view = { ...t, categoriesArray: safeArrayJSON(t.categories), estimatedCostNumber: Number(t.estimated_cost||0) };
    res.render('ticket_detail', { t:view, CT_ZONE });
  })();
});

app.post('/admin/tickets/:id/status', requireAdmin, (req,res)=>{
  const valid = new Set(['new','scheduled','completed','canceled']);
  const s = String(req.body.status||'').toLowerCase();
  if(!valid.has(s)) return res.status(400).send('Invalid status');
  db.updateStatus(req.params.id, s);
  res.redirect('/admin/tickets/'+req.params.id);
});

app.post('/admin/tickets/:id/timecost', requireAdmin, (req,res)=>{
  const t = db.getTicket(req.params.id);
  if(!t) return res.status(404).send('Ticket not found');
  const hourly = parseFloat(process.env.EMPLOYEE_HOURLY||10);
  const crew = parseInt(req.body.crew_size||t.crew_size||1);
  const fuelPerMile = parseFloat(req.body.fuel_cost_per_mile||t.fuel_cost_per_mile||0.2);
  const fresh = db.getTicket(req.params.id);
  const miles = parseFloat(fresh.estimated_miles||0)||0;
  const drive = parseFloat(fresh.drive_minutes||0)||0;
  db.updateCrewSize(t.id, crew);
  db.updateTimesAndCost(t.id, drive, 0, hourly, crew, fuelPerMile, miles);
  res.redirect('/admin/tickets/'+t.id);
});

// Schedule & calendar endpoints (same as before)
app.get('/admin/availability', requireAdmin, (req,res)=>{ res.render('availability', { events: db.listScheduled(), CT_ZONE }); });
app.get('/admin/calendar', requireAdmin, (req,res)=>res.render('admin_calendar'));
app.get('/api/schedule', requireAdmin, (req,res)=>{
  const events = db.listScheduled().map(e=>({ id:e.id, title:`#${e.ticket_id} - ${e.donor_name}`, start:e.start_iso, end:e.end_iso }));
  res.json(events);
});
app.get('/admin/blackouts', requireAdmin, (req,res)=>{ res.render('admin_blackouts', { days: db.listBlackouts(), CT_ZONE }); });
app.post('/admin/blackouts', requireAdmin, (req,res)=>{ const d=String(req.body.date||'').trim(); if(d) db.addBlackout(d); res.redirect('/admin/blackouts'); });
app.post('/admin/blackouts/:id/delete', requireAdmin, (req,res)=>{ db.deleteBlackout(req.params.id); res.redirect('/admin/blackouts'); });
app.get('/api/blackouts', requireAdmin, (req,res)=>{
  const { DateTime } = require('luxon');
  const days = db.listBlackouts();
  res.json(days.map(d=>({ start:d.date, end: DateTime.fromISO(d.date).plus({days:1}).toISODate(), display:'background', backgroundColor:'#ffd6d6' })));
});
app.post('/admin/tickets/:id/schedule', requireAdmin, (req,res)=>{
  const start = DateTime.fromISO(req.body.start_iso, { zone: CT_ZONE });
  const end = start.plus({ hours: parseFloat(req.body.duration_hours||1) });
  const b = validateBusinessHoursCT(start, end);
  if(!b.ok) return res.status(400).send(b.msg);
  const conflicts = db.findConflicts(start.toISO(), end.toISO());
  if(conflicts.length) return res.status(400).send('Conflict with existing schedule.');
  db.scheduleTicket(req.params.id, start.toISO(), end.toISO());
  res.redirect('/admin/tickets');
});
app.post('/admin/schedule/:id/move', requireAdmin, (req,res)=>{
  const start = DateTime.fromISO(req.body.start_iso, { zone: CT_ZONE });
  const end = DateTime.fromISO(req.body.end_iso, { zone: CT_ZONE });
  const b = validateBusinessHoursCT(start, end);
  if(!b.ok) return res.status(409).json({ error: b.msg });
  const conflicts = db.findConflicts(start.toISO(), end.toISO()).filter(e=> String(e.id)!==String(req.params.id));
  if(conflicts.length) return res.status(409).json({ error: 'Conflict' });
  db.updateSchedule(req.params.id, start.toISO(), end.toISO());
  res.json({ ok:true });
});

// CSV export
app.get('/admin/export.csv', requireAdmin, (req,res)=>{
  const rows = db.listTickets();
  const headers = ['id','created_at','status','donor_name','donor_email','donor_phone','pickup_address','city','state','zip','categories','condition','item_notes','preferred_date','preferred_time','bags_count','furniture_count','small_donation','crew_size','estimated_miles','drive_minutes','fuel_cost_per_mile','estimated_cost'];
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="tickets.csv"');
  res.write(headers.join(',')+'\n');
  for(const r of rows){
    const vals = headers.map(h=>{
      let v = r[h];
      if(h==='categories' && typeof v==='string'){ try{ v = JSON.parse(v).join('|'); }catch{} }
      if(typeof v === 'string') v = `"${v.replace(/"/g,'""')}"`;
      return v ?? '';
    });
    res.write(vals.join(',')+'\n');
  }
  res.end();
});

// Error handler
app.use((err, req, res, next)=>{ console.error('Unhandled error:', err); res.status(500).send('Internal Server Error'); });

app.listen(PORT, ()=>{ db.init(); console.log(`Server running on http://localhost:${PORT}`); });
