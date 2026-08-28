const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

let players = {};

// قائمة الدول المتاحة مع أعلامها ومعالمها
const countriesList = [
    { code: "SY", name: "سوريا", flag: "🇸🇾" },
    { code: "SA", name: "السعودية", flag: "🇸🇦" },
    { code: "TR", name: "تركيا", flag: "🇹🇷" },
    { code: "EG", name: "مصر", flag: "🇪🇬" },
    { code: "AE", name: "الإمارات", flag: "🇦🇪" },
    { code: "IQ", name: "العراق", flag: "🇮🇶" }
];

function getFlagEmoji(countryCode) {
    const found = countriesList.find(c => c.code === countryCode);
    return found ? found.flag : "🌐";
}

// 1. توليد لاعبين/بوتات محاكاة لإضفاء الحيوية للميدان
function spawnBotPlayer(idSuffix) {
    const country = countriesList[Math.floor(Math.random() * countriesList.length)];
    const playerId = 'bot_' + idSuffix;
    const points = Math.floor(Math.random() * 45000) + 3000;

    players[playerId] = {
        id: playerId,
        name: `King_${idSuffix}`,
        country: { code: country.code, name: country.name, flag: country.flag },
        points: points,
        x: Math.random() * 5000 + 500,
        y: Math.random() * 5000 + 500,
        vx: (Math.random() - 0.5) * 5,
        vy: (Math.random() - 0.5) * 5,
        radius: Math.max(35, Math.sqrt(points) * 0.45)
    };
}

// إنشاء 8 بوتات عند بدء الخادم
for (let i = 1; i <= 8; i++) {
    spawnBotPlayer(i);
}

// 2. إدارة الاتصال الفعلي للاعبين عبر WebSocket
wss.on('connection', async (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    
    let countryCode = "SY";
    let countryName = "سوريا";
    
    try {
        const geoRes = await fetch(`https://ipapi.co/${ip}/json/`);
        const geoData = await geoRes.json();
        if (geoData.country_code) {
            countryCode = geoData.country_code;
            countryName = geoData.country_name;
        }
    } catch (e) {}

    const playerId = 'user_' + Math.random().toString(36).substr(2, 7);
    const points = Math.floor(Math.random() * 25000) + 12000;

    players[playerId] = {
        id: playerId,
        name: `أنت (اللاعب)`,
        country: { code: countryCode, name: countryName, flag: getFlagEmoji(countryCode) },
        points: points,
        x: Math.random() * 4000 + 1000,
        y: Math.random() * 4000 + 1000,
        vx: (Math.random() - 0.5) * 3,
        vy: (Math.random() - 0.5) * 3,
        radius: Math.max(40, Math.sqrt(points) * 0.45)
    };

    ws.send(JSON.stringify({ type: 'INIT', selfId: playerId, players }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            // إمكانية تحديث نقاط أو إحداثيات اللاعب الحقيقي
            if (data.type === 'UPDATE_SCORE' && players[playerId]) {
                players[playerId].points = data.points;
                players[playerId].radius = Math.max(35, Math.sqrt(data.points) * 0.45);
            }
        } catch (err) {}
    });

    ws.on('close', () => {
        delete players[playerId];
    });
});

// 3. محاكة حركة الكرات وتغير النقاط المباشر (Game Loop)
setInterval(() => {
    Object.values(players).forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        // ارتداد الكرات من الحدود
        if (p.x < 150 || p.x > 5850) p.vx *= -1;
        if (p.y < 150 || p.y > 5850) p.vy *= -1;

        // تغير طفيف في النقاط لزيادة الحيوية
        if (Math.random() < 0.05) {
            p.points += Math.floor((Math.random() - 0.48) * 150);
            p.points = Math.max(1000, p.points);
            p.radius = Math.max(35, Math.sqrt(p.points) * 0.45);
        }
    });

    const payload = JSON.stringify({ type: 'SYNC', players });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 40);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Dominance Engine running with Active Bots & Live Sync on port ${PORT}`);
});