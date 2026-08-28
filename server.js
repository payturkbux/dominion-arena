const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

// ⚡ قراءة المفاتيح مباشرة من متغيرة البيئة في Render
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STAND_LOCATIONS = {
    "SY": { x: 1200, y: 1100 },
    "SA": { x: 2400, y: 1100 },
    "TR": { x: 3600, y: 1100 },
    "EG": { x: 4800, y: 1100 },
    "AE": { x: 6000, y: 1100 }
};

let activePlayers = {};
let standVault = {};

wss.on('connection', async (ws, req) => {
    const urlParams = new URLSearchParams(req.url.replace(/^.*\?/, ''));
    const userId = urlParams.get('userId');
    const socketId = userId || 'user_' + Math.random().toString(36).substr(2, 9);

    ws.id = socketId;

    let userData = {
        name: 'لاعب جديد',
        points: 100,
        tier: 'Bronze',
        countryCode: 'SY'
    };

    if (userId) {
        const { data, error } = await supabase
            .from('profiles')
            .select('display_name, points_balance, tier, country_code')
            .eq('id', userId)
            .single();

        if (data && !error) {
            userData.name = data.display_name || userData.name;
            userData.points = data.points_balance ?? userData.points;
            userData.tier = data.tier || userData.tier;
            userData.countryCode = data.country_code || userData.countryCode;
        }
    }

    const initialStand = STAND_LOCATIONS[userData.countryCode] || STAND_LOCATIONS["SY"];

    standVault[socketId] = {
        id: socketId,
        name: userData.name,
        points: userData.points,
        tier: userData.tier,
        inStand: true,
        x: initialStand.x + (Math.random() * 100 - 50),
        y: initialStand.y + (Math.random() * 100 - 50),
        radius: 40,
        country: { code: userData.countryCode }
    };

    ws.send(JSON.stringify({ type: 'INIT', selfId: socketId }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'ENTER_ARENA') {
                if (standVault[socketId]) {
                    const p = standVault[socketId];
                    delete standVault[socketId];
                    p.inStand = false;
                    p.x = data.targetX || 3600;
                    p.y = data.targetY || 3700;
                    p.targetX = p.x;
                    p.targetY = p.y;
                    activePlayers[socketId] = p;
                }
            } else if (data.type === 'TARGET') {
                if (activePlayers[socketId]) {
                    activePlayers[socketId].targetX = data.x;
                    activePlayers[socketId].targetY = data.y;
                }
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        delete activePlayers[socketId];
        delete standVault[socketId];
    });
});

setInterval(() => {
    Object.values(activePlayers).forEach(p => {
        if (p.targetX !== undefined && p.targetY !== undefined) {
            p.x += (p.targetX - p.x) * 0.15;
            p.y += (p.targetY - p.y) * 0.15;
        }
    });

    const payload = JSON.stringify({
        type: 'SYNC',
        activePlayers,
        standVault
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));