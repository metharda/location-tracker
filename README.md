# Location Tracking System

Real-time web application that displays GPS coordinates from any device can send a POST request on an interactive map.

## 🚀 Features

## Location Tracker

Location Tracker is a lightweight real-time web application for visualizing GPS reports sent by devices. The server accepts POST location updates, stores trips and points in SQLite, and streams current positions to browser clients using Server-Sent Events (SSE).

Key capabilities:
- Real-time device location updates via SSE
- Persistent trip storage (SQLite) with per-trip points
- Web UI with interactive Leaflet map, trip listing and route drawing (OSRM fallback)
- Filtering of GPS jitter (configurable threshold) to avoid spurious trip points

## Requirements

- Node.js (v18+ recommended)
- npm
- Optional: Nginx for reverse proxy / SSL termination

## Project layout

```
location-tracker/
├── app/
│   ├── index.html          # Frontend UI (Leaflet)
│   ├── server.js           # Express server and API
│   ├── create_test_trip.js # Helper script to insert a test trip
├── data/                   # runtime SQLite database (ignored by git)
├── examples/               # device examples (ESP32 sketch)
├── package.json
└── README.md
```

## Installation

1. Clone repository and install dependencies

```bash
git clone https://github.com/metharda/location-tracker.git
cd location-tracker
npm install
```

2. Start the server

```bash
npm start
# Or directly: node app/server.js
```

The server listens on port 3000 by default.

## Endpoints

- `POST /location` — Accepts JSON body `{ "lat": <number>, "lng": <number> }`. Provide an `id` header (or `id` query param) to identify the device. Multiple IDs can be provided (comma-separated) to record the same position for multiple devices.
- `GET /location` — Returns the current location and recent history for all devices or `?id=...` for a single device.
- `GET /ids` — Returns the list of known device IDs.
- `GET /trips?id=<deviceId>` — Returns trips for a device, each with its ordered points.
- `DELETE /trips?tripId=<id>` — Deletes a trip and its points from the database.
- `GET /events` — Server-Sent Events stream for live location updates. Subscribe with `EventSource('/events')`.

## Trip recording and jitter filtering

- The server persists trips and points to a SQLite database at `data/trips.db`.
- A new trip is started automatically if the time gap between consecutive reports exceeds 5 minutes (configurable in `app/server.js` via `TRIP_GAP_MS`).
- To avoid recording small GPS jitter as movement, the server ignores point-to-point movements smaller than a distance threshold (default 10 meters, configurable via `MIN_DISTANCE_METERS` in `app/server.js`).

## Frontend usage

1. Open the UI in a browser at `http://localhost:3000`.
2. The left sidebar lists devices and trips. Select a device to view its trips and draw routes on the map.
3. Trip cards include a Delete button that removes the trip from the database and clears any drawn route.

## Testing helpers

- Insert a sample test trip into the database (useful for local testing):

```bash
node app/create_test_trip.js [deviceId]
# Example: node app/create_test_trip.js test-device
```

- Example cURL to post a location (replace host as needed):

```bash
curl -X POST http://localhost:3000/location \
  -H "Content-Type: application/json" \
  -H "id: test-device" \
  -d '{"lat":41.0082,"lng":28.9784}'
```

- Delete a trip by id:

```bash
curl -X DELETE "http://localhost:3000/trips?tripId=2"
```

## Deployment notes

- For production, run the Node process under a process manager (systemd, pm2, etc.).
- Use Nginx as a reverse proxy and to terminate TLS. Ensure `/events` is proxied with buffering disabled and a long read timeout to support SSE.

Example Nginx snippet for SSE (excerpt):

```nginx
location /events {
    proxy_pass http://127.0.0.1:3000/events;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Cache-Control 'no-cache';
    proxy_set_header X-Accel-Buffering 'no';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
}
```

## Security and production considerations

- The project currently exposes delete endpoints without authentication. For production use, add authentication and authorization (API keys, JWTs, or HTTP basic auth for the deploy environment).
- The `sqlite3` native module may require build tools on some platforms (install build-essential / python / libsqlite3-dev where needed).

## License

This project is licensed under the MIT License.
