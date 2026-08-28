const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

let activePlayers = {};  // الكرات النازلة على أرض الملعب
let standVault = {};     // الكرات الموجودة على المدرجات (الآمنة)

const countriesList = [
    { code: "SY", name: "سوريا", flag: "🇸🇾", standX: 1200, standY: 450 },
    { code: "SA", name: "السعودية", flag: "🇸🇦", standX: 2400, standY: 450 },
    { code: "TR", name: "تركيا", flag: "🇹🇷", standX: 3600, standY: 450 },
    { code: "EG", name: "مصر", flag: "🇪🇬", standX: 4800, standY: 450 },
    { code: "AE", name: "الإمارات", flag: "🇦🇪", standX: 6000, standY: 450 }
];

// توزيع كرات الحسابات الحالية على صفوف المدرجات بشكل منظم
countriesList.forEach((c) => {
    for (let i = 1; i <= 6; i++) {
        const id = `stand_${c.code}_${i}`;
        const pts = Math.floor(Math.random() * 35000) + 12000;
        
        // حساب موقع المقعد على المدرج (صفين x 3 أعمدة)
        const row = Math.floor((i - 1) / 3);
        const col = (i - 1) % 3;

        standVault[id] = {
            id: id,
            name: `عضو_${c.name}_${i}`,
            country: c,
            points: pts,
            inStand: true,
            x: c.standX + (col - 1) * 220,
            y: c.standY + row * 180,
            radius: Math.max(38, Math.sqrt(pts) * 0.42)
        };
    }
});

wss.on('connection', (ws) => {
    const playerId = 'user_' + Math.random().toString(36).substr(2, 6);
    const userCountry = countriesList[0]; // سوريا افتراضياً
    const startPts = 30000;

    // عند الاتصال: تنزل الكرة إلى أرضية الملعب (Pitch)
    activePlayers[playerId] = {
        id: playerId,
        name: "أنت (اللاعب)",
        country: userCountry,
        points: startPts,
        inStand: false,
        x: 3600 + (Math.random() - 0.5) * 800,
        y: 3500 + (Math.random() - 0.5) * 800,
        vx: 0, vy: 0,
        radius: Math.max(38, Math.sqrt(startPts) * 0.42)
    };

    ws.send(JSON.stringify({ type: 'INIT', selfId: playerId }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'TARGET' && activePlayers[playerId]) {
                const p = activePlayers[playerId];
                const dx = data.x - p.x;
                const dy = data.y - p.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > 10) {
                    p.vx = (dx / dist) * 6.5;
                    p.vy = (dy / dist) * 6.5;
                } else {
                    p.vx = 0; p.vy = 0;
                }
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        // عند قطع الاتصال: تعود الكرة فوراً إلى مقعدها بالمدرج بأمان
        if (activePlayers[playerId]) {
            const p = activePlayers[playerId];
            p.inStand = true;
            p.vx = 0; p.vy = 0;
            p.x = p.country.standX;
            p.y = p.country.standY;
            standVault[playerId] = p;
            delete activePlayers[playerId];
        }
    });
});

// محرك اللعبة والتصادم داخل حدود أرضية الملعب فقط
setInterval(() => {
    const activeList = Object.values(activePlayers);

    activeList.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        // حدود أرضية الملعب (الخطوط البيضاء للمستطيل الأخضر)
        if (p.x < 500 || p.x > 6700) p.vx *= -1;
        if (p.y < 1900 || p.y > 5500) p.vy *= -1;
    });

    // الابتلاع يحدث فقط بين اللاعبين على أرضية الملعب
    for (let i = 0; i < activeList.length; i++) {
        for (let j = i + 1; j < activeList.length; j++) {
            const a = activeList[i];
            const b = activeList[j];
            const dist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

            if (dist < Math.abs(a.radius - b.radius) + 10) {
                const bigger = a.radius > b.radius ? a : b;
                const smaller = a.radius > b.radius ? b : a;

                if (bigger.radius > smaller.radius * 1.1) {
                    smaller.points = Math.max(1, smaller.points - 1);
                    bigger.points += 1;
                    smaller.radius = Math.max(38, Math.sqrt(smaller.points) * 0.42);
                    bigger.radius = Math.max(38, Math.sqrt(bigger.points) * 0.42);
                    smaller.x = 3600 + (Math.random() - 0.5) * 1200;
                    smaller.y = 3700 + (Math.random() - 0.5) * 1200;
                }
            }
        }
    }

    const payload = JSON.stringify({ 
        type: 'SYNC', 
        activePlayers: activePlayers,
        standVault: standVault
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 40);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Stadium Engine running on port ${PORT}`));