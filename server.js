const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

let activePlayers = {};  // الكرات المتصلة والنازلة إلى الحلبة
let safeVault = {};     // الكرات المحفوظة في مسرح الأمان (غير متصلين)

const countriesList = [
    { code: "SY", name: "سوريا", flag: "🇸🇾", vaultX: 1000, vaultY: 800 },
    { code: "SA", name: "السعودية", flag: "🇸🇦", vaultX: 2200, vaultY: 800 },
    { code: "TR", name: "تركيا", flag: "🇹🇷", vaultX: 3400, vaultY: 800 },
    { code: "EG", name: "مصر", flag: "🇪🇬", vaultX: 4600, vaultY: 800 },
    { code: "AE", name: "الإمارات", flag: "🇦🇪", vaultX: 5800, vaultY: 800 }
];

// إضافة كرات متواجدة في المسرح المحمي (حسابات غير متصلة)
countriesList.forEach((c, idx) => {
    for (let i = 1; i <= 3; i++) {
        const id = `vault_${c.code}_${i}`;
        const pts = Math.floor(Math.random() * 30000) + 10000;
        safeVault[id] = {
            id: id,
            name: `عضو_${c.name}_${i}`,
            country: c,
            points: pts,
            inVault: true, // مؤشر الأمان
            x: c.vaultX + (Math.random() - 0.5) * 400,
            y: c.vaultY + (Math.random() - 0.5) * 300,
            radius: Math.max(35, Math.sqrt(pts) * 0.45)
        };
    }
});

wss.on('connection', (ws) => {
    const playerId = 'user_' + Math.random().toString(36).substr(2, 6);
    const userCountry = countriesList[0]; // سوريا افتراضياً
    const startPts = 25000;

    // عند الاتصال: تنزل الكرة مباشرة إلى حلبة المواجهة
    activePlayers[playerId] = {
        id: playerId,
        name: "أنت (نشط)",
        country: userCountry,
        points: startPts,
        inVault: false,
        x: 3000 + (Math.random() - 0.5) * 600,
        y: 3500 + (Math.random() - 0.5) * 600,
        vx: 0, vy: 0,
        radius: Math.max(35, Math.sqrt(startPts) * 0.45)
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
                    p.vx = (dx / dist) * 6;
                    p.vy = (dy / dist) * 6;
                } else {
                    p.vx = 0; p.vy = 0;
                }
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        // عند قطع الاتصال: تعود الكرة فوراً إلى المسرح المحمي بأمان!
        if (activePlayers[playerId]) {
            const p = activePlayers[playerId];
            p.inVault = true;
            p.vx = 0; p.vy = 0;
            p.x = p.country.vaultX;
            p.y = p.country.vaultY;
            safeVault[playerId] = p;
            delete activePlayers[playerId];
        }
    });
});

// Game Loop: تحريك ومعالجة التصادم فقط للكرات الموجودة بالحلبة
setInterval(() => {
    const activeList = Object.values(activePlayers);

    activeList.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        // حدود حلبة الصراع السفلية (من Y: 2000 إلى Y: 6000)
        if (p.x < 200 || p.x > 6800) p.vx *= -1;
        if (p.y < 2100 || p.y > 5900) p.vy *= -1;
    });

    // التصادم محصور بين الكرات النشطة بالحلبة فقط!
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
                    smaller.radius = Math.max(35, Math.sqrt(smaller.points) * 0.45);
                    bigger.radius = Math.max(35, Math.sqrt(bigger.points) * 0.45);
                    smaller.x = 3400 + (Math.random() - 0.5) * 1000;
                    smaller.y = 4000 + (Math.random() - 0.5) * 1000;
                }
            }
        }
    }

    const payload = JSON.stringify({ 
        type: 'SYNC', 
        activePlayers: activePlayers,
        safeVault: safeVault
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 40);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Arena & Safe Haven Server active on port ${PORT}`));