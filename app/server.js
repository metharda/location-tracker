const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(__dirname));

const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'trips.db');
const db = new sqlite3.Database(DB_PATH);

const MAX_LOCATIONS = 200;
const TRIP_GAP_MS = 5 * 60 * 1000;
const clients = {};
const sseClients = [];

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS trips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT,
        started_at TEXT,
        ended_at TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER,
        seq INTEGER,
        lat REAL,
        lng REAL,
        ts TEXT,
        FOREIGN KEY(trip_id) REFERENCES trips(id)
    )`);
});

function createNewTrip(deviceId, timestamp, callback) {
    db.run(`INSERT INTO trips(device_id, started_at) VALUES(?,?)`, [deviceId, timestamp], function(err) {
        if (err) return callback(err);
        callback(null, this.lastID);
    });
}

function closeTrip(tripId, endedAt) {
    if (!tripId) return;
    db.run(`UPDATE trips SET ended_at = ? WHERE id = ?`, [endedAt, tripId]);
}

function insertPoint(tripId, seq, lat, lng, ts) {
    db.run(`INSERT INTO points(trip_id, seq, lat, lng, ts) VALUES(?,?,?,?,?)`, [tripId, seq, lat, lng, ts]);
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/location', (req, res) => {
    const { lat, lng } = req.body;
    if (lat === undefined || lng === undefined) {
        return res.status(400).json({ error: 'lat and lng required' });
    }
    const headerIds = req.header('id') || req.header('ids') || req.query.id || req.query.ids || 'default';
    const ids = String(headerIds).split(',').map(s => s.trim()).filter(Boolean);

    const timestamp = new Date().toISOString();

    const results = [];
    ids.forEach(id => {
        if (!clients[id]) {
            clients[id] = { lastLocation: null, history: [], currentTripId: null, seq: 0 };
        }

        const location = {
            id,
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            timestamp
        };

        const store = clients[id];
        store.history = store.history || [];
        store.history.push(location);
        if (store.history.length > MAX_LOCATIONS) store.history.shift();

        const prev = store.lastLocation;
        const nowMs = new Date(timestamp).getTime();
        let needNewTrip = false;
        if (!prev) {
            needNewTrip = true;
        } else {
            const prevTime = new Date(prev.timestamp).getTime();
            if (nowMs - prevTime > TRIP_GAP_MS) needNewTrip = true;
        }

        if (needNewTrip) {
            if (store.currentTripId) closeTrip(store.currentTripId, timestamp);
            createNewTrip(id, timestamp, (err, tripId) => {
                if (err) console.error('createNewTrip err', err);
                else {
                    store.currentTripId = tripId;
                    store.seq = 0;
                    insertPoint(tripId, store.seq++, location.lat, location.lng, timestamp);
                }
            });
        } else {
            if (!store.currentTripId) {
                createNewTrip(id, timestamp, (err, tripId) => {
                    if (err) console.error('createNewTrip err', err);
                    else {
                        store.currentTripId = tripId;
                        store.seq = 0;
                        insertPoint(tripId, store.seq++, location.lat, location.lng, timestamp);
                    }
                });
            } else {
                insertPoint(store.currentTripId, store.seq++, location.lat, location.lng, timestamp);
            }
        }

        store.lastLocation = location;
        results.push(location);

        console.log(`New location (id=${id}): ${lat}, ${lng}`);
    });

    sseClients.forEach(({ res: sres, ids: subIds }) => {
        const sendToClient = subIds.size === 0 || ids.some(i => subIds.has(i));
        if (sendToClient) {
            results.forEach(loc => {
                try {
                    sres.write(`data: ${JSON.stringify(loc)}\n\n`);
                } catch (e) {
                    // ignore write errors
                }
            });
        }
    });

    res.json({ status: 'success', message: 'Location(s) updated', locations: results });
});

app.get('/location', (req, res) => {
    const id = req.query.id;
    if (id) {
        const store = clients[id];
        if (!store) return res.json({ current: null, history: [], trips: [] });
        return res.json({ current: store.lastLocation, history: store.history, trips: store.trips });
    }

    const all = {};
    Object.keys(clients).forEach(k => {
        all[k] = {
            current: clients[k].lastLocation,
            history: clients[k].history,
            trips: clients[k].trips
        };
    });
    res.json(all);
});

app.delete('/locations', (req, res) => {
    Object.keys(clients).forEach(k => {
        clients[k] = { lastLocation: null, history: [], trips: [], currentTrip: [] };
    });
    res.json({ status: 'success', message: 'Locations cleared' });
});

app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const idsQuery = req.query.ids || req.query.id || '';
    const ids = idsQuery ? String(idsQuery).split(',').map(s => s.trim()).filter(Boolean) : [];
    const idsSet = new Set(ids);

    const client = { res, ids: idsSet };
    sseClients.push(client);
    if (ids.length) {
        ids.forEach(id => {
            const store = clients[id];
            if (store && store.lastLocation) {
                res.write(`data: ${JSON.stringify(store.lastLocation)}\n\n`);
            }
        });
    } else {
        Object.keys(clients).forEach(k => {
            if (clients[k].lastLocation) {
                res.write(`data: ${JSON.stringify(clients[k].lastLocation)}\n\n`);
            }
        });
    }

    req.on('close', () => {
        const idx = sseClients.indexOf(client);
        if (idx !== -1) sseClients.splice(idx, 1);
    });
});

app.get('/ids', (req, res) => {
    res.json(Object.keys(clients));
});

app.get('/trips', (req, res) => {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id query param required' });
    db.all(`SELECT id, device_id, started_at, ended_at FROM trips WHERE device_id = ? ORDER BY started_at DESC`, [id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'db error' });
        const trips = [];
        if (!rows || rows.length === 0) return res.json({ trips });
        let remaining = rows.length;
        rows.forEach(tr => {
            db.all(`SELECT seq, lat, lng, ts FROM points WHERE trip_id = ? ORDER BY seq ASC`, [tr.id], (err2, pts) => {
                if (err2) pts = [];
                trips.push({ id: tr.id, started_at: tr.started_at, ended_at: tr.ended_at, points: pts || [] });
                remaining -= 1;
                if (remaining === 0) {
                    trips.sort((a,b)=> new Date(a.started_at)-new Date(b.started_at));
                    res.json({ trips });
                }
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('\nTest commands:');
    console.log('POST: curl -X POST http://localhost:3000/location -H "Content-Type: application/json" -H "id: mydevice" -d \"{\'lat\':41.0082,\'lng\':28.9784}\"');
    console.log('GET:  curl http://localhost:3000/location');
});
