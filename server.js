const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

let players = {};

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

// إنشاء بوتات منافسة
for (let i = 1; i <= 6; i++) {
    const country = countriesList[i % countriesList.length];
    const id = 'bot_' + i;
    const pts = Math.floor(Math.random() * 20000) + 5000;
    players[id] = {
        id: id,
        isBot: true,
        name: `Bot_${i}`,
        country: { code: country.code, name: country.name, flag: country.flag },
        points: pts,
        x: Math.random() * 4000 + 1000,
        y: Math.random() * 4000 + 1000,
        vx: (Math.random() - 0.5) * 4,
        vy: (Math.random() - 0.5) * 4,
        radius: Math.max(35, Math.sqrt(pts) * 0.45)
    };
}

wss.on('connection', (ws) => {
    const playerId = 'user_' + Math.random().toString(36).substr(2, 6);
    const startPoints = 15000; // رصيد البداية المربوط بالموقع

    players[playerId] = {
        id: playerId,
        isBot: false,
        name: "أنت (اللاعب)",
        country: { code: "SY", name: "سوريا", flag: "🇸🇾" },
        points: startPoints,
        x: 3000,
        y: 3000,
        vx: 0,
        vy: 0,
        radius: Math.max(35, Math.sqrt(startPoints) * 0.45)
    };

    ws.send(JSON.stringify({ type: 'INIT', selfId: playerId, players }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            // تحريك الكرة باتجاه الماوس
            if (data.type === 'TARGET' && players[playerId]) {
                const p = players[playerId];
                const dx = data.x - p.x;
                const dy = data.y - p.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > 10) {
                    p.vx = (dx / dist) * 5;
                    p.vy = (dy / dist) * 5;
                } else {
                    p.vx = 0; p.vy = 0;
                }
            }
        } catch (err) {}
    });

    ws.on('close', () => { delete players[playerId]; });
});

// Game Loop: تحريك ومعالجة التصادم والابتلاع
setInterval(() => {
    const playerList = Object.values(players);

    playerList.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 100 || p.x > 5900) p.vx *= -1;
        if (p.y < 100 || p.y > 5900) p.vy *= -1;

        if (p.isBot && Math.random() < 0.02) {
            p.vx = (Math.random() - 0.5) * 4;
            p.vy = (Math.random() - 0.5) * 4;
        }
    });

    // معالجة تصادم وتأثير الابتلاع (Agar.io Mechanic)
    for (let i = 0; i < playerList.length; i++) {
        for (let j = i + 1; j < playerList.length; j++) {
            const a = playerList[i];
            const b = playerList[j];

            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // عند تداخل الكرتين
            if (dist < Math.abs(a.radius - b.radius) + 10) {
                const bigger = a.radius > b.radius ? a : b;
                const smaller = a.radius > b.radius ? b : a;

                // الابتلاع يحدث إذا كانت إحداهما أكبر بـ 10% على الأقل
                if (bigger.radius > smaller.radius * 1.1) {
                    // خصم نقطة واحدة فقط رمزية وإضافتها للكبير
                    smaller.points = Math.max(1, smaller.points - 1);
                    bigger.points += 1;

                    // تحديث الأقطار
                    smaller.radius = Math.max(35, Math.sqrt(smaller.points) * 0.45);
                    bigger.radius = Math.max(35, Math.sqrt(bigger.points) * 0.45);

                    // إعادة ظهور الأصغر في مكان جديد بنفس حجمه المتبقي
                    smaller.x = Math.random() * 5000 + 500;
                    smaller.y = Math.random() * 5000 + 500;
                }
            }
        }
    }

    const payload = JSON.stringify({ type: 'SYNC', players });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 40);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Gaming Engine live on port ${PORT}`));