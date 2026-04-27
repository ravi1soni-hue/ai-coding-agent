"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSocketServer = createSocketServer;
// Simple WebSocket server using ws
const ws_1 = require("ws");
function createSocketServer(server) {
    const wss = new ws_1.Server({ server });
    wss.on('connection', (ws) => {
        ws.on('message', (message) => {
            // Echo the message back for now
            ws.send(`Echo: ${message}`);
        });
        ws.send('WebSocket connection established!');
    });
    return wss;
}
