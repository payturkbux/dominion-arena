const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// 1. تعريف مصفوفة اللاعبين في البداية لتجنب خطأ ReferenceError
let players = {};

// تحويل رمز الدولة إلى علم Emoji
function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) return "🌐";
    const codePoints = countryCode
        .toUpperCase()
        .split('')
        .map(char => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
}

// 2. إيقاف وإدارة الاتصالات عبر WebSocket
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
    } catch (e) {
        console.log("GeoIP fallback used for IP:", ip);
    }

    const playerId = 'player_' + Math.random().toString(36).substr(2, 9);
    const points = Math.floor(Math.random() * 30000) + 5000;
    
    // إنشاء بيانات اللاعب الجديد
    players[playerId] = {
        id: playerId,
        name: `Dominator_${playerId.substr(7)}`,
        country: { code: countryCode, name: countryName, flag: getFlagEmoji(countryCode) },
        points: points,
        x: Math.random() * 4000 + 1000,
        y: Math.random() * 4000 + 1000,
        vx: (Math.random() - 0.5) * 6,
        vy: (Math.random() - 0.5) * 6,
        radius: Math.max(30, Math.sqrt(points) * 0.4)
    };

    // إرسال معرف اللاعب الموصل
    ws.send(JSON.stringify({ type: 'INIT', selfId: playerId, players }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'MOVE' && players[playerId]) {
                players[playerId].x = data.x;
                players[playerId].y = data.y;
            }
        } catch (err) {}
    });

    ws.on('close', () => {
        delete players[playerId];
    });
});

// 3. حلقة تحريك الكرات وبث البيانات (Loop)
setInterval(() => {
    Object.values(players).forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        // ارتداد من الجدران
        if (p.x < 100 || p.x > 5900) p.vx *= -1;
        if (p.y < 100 || p.y > 5900) p.vy *= -1;
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
    console.log(`Dominance Server running on port ${PORT}`);
});