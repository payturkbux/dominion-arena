const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// مصفوفة اللاعبين في الميدان
let players = {};

// تحويل رمز الدولة لعلم Emojis
function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) return "🌐";
    const codePoints = countryCode
        .toUpperCase()
        .split('')
        .map(char => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
}

wss.on('connection', async (ws, req) => {
    // استخراج IP اللاعب من طلب التوصيل على Render
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    
    let countryCode = "SY";
    let countryName = "سوريا";
    
    try {
        // جلب علم وبينات الدولة من الـ IP
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
    
    players[playerId] = {
        id: playerId,
        name: `P_${playerId.substr(7)}`,
        country: { code: countryCode, name: countryName, flag: getFlagEmoji(countryCode) },
        points: Math.floor(Math.random() * 20000) + 5000,
        x: Math.random() * 5000 + 500,
        y: Math.random() * 5000 + 500,
        radius: 45
    };

    // إرسال هويته الحالية عند التوصيل
    ws.send(JSON.stringify({ type: 'INIT', selfId: playerId, players }));

    // استقبال تحديث الحركة أو النقاط من الكلاينت
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

// بث الإحداثيات والنقاط لجميع اللاعبين الموصلين كل 50 ملي ثانية (20 FPS Sync)
setInterval(() => {
    const payload = JSON.stringify({ type: 'SYNC', players });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Dominance Server running on port ${PORT}`);
});