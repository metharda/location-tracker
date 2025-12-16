const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(__dirname));

const MAX_LOCATIONS = 200;
const TRIP_GAP_MS = 5 * 60 * 1000;
const clients = {};
const sseClients = [];

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
            clients[id] = { lastLocation: null, history: [], trips: [], currentTrip: [] };
        }

        const location = {
            id,
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            timestamp
        };

        const store = clients[id];
        store.history.push(location);
        if (store.history.length > MAX_LOCATIONS) store.history.shift();
        const prev = store.lastLocation;
        if (!prev) {
            store.currentTrip = [location];
        } else {
            const prevTime = new Date(prev.timestamp).getTime();
            const now = new Date(timestamp).getTime();
            if (now - prevTime > TRIP_GAP_MS) {
                if (store.currentTrip && store.currentTrip.length) {
                    store.trips.push(store.currentTrip);
                }
                store.currentTrip = [location];
            } else {
                store.currentTrip = store.currentTrip || [];
                store.currentTrip.push(location);
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
    const store = clients[id];
    if (!store) return res.json({ trips: [] });
    const trips = store.trips.slice();
    if (store.currentTrip && store.currentTrip.length) trips.push(store.currentTrip);
    res.json({ trips });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('\nTest commands:');
    console.log('POST: curl -X POST http://localhost:3000/location -H "Content-Type: application/json" -H "id: mydevice" -d \"{\'lat\':41.0082,\'lng\':28.9784}\"');
    console.log('GET:  curl http://localhost:3000/location');
});
