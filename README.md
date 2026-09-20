# Deal Online

Browser-based multiplayer property card game (Monopoly Deal-style), 2-5 players, bots can fill seats.

    npm install
    npm start          # http://localhost:3000  (set PORT to change)

Create a room, share the 4-letter code or link, add bots, start.

- `game.js`   rules engine + bot AI (no I/O)
- `server.js` HTTP + WebSocket rooms, reconnect, bot scheduling
- `public/index.html` the whole client
- `npm test`  400 bot-only games checking card conservation and termination

To play with friends over the internet the server must be reachable: deploy to any Node host
(Render, Railway, Fly.io) or tunnel your PC (`npx localtunnel --port 3000`, cloudflared, ngrok).
