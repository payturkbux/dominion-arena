require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

const PITCH_BOUNDS = { minX: 500, maxX: 6700, minY: 1900, maxY: 5500 };
const STAND_LOCATIONS = {
    "SY": { x: 1200, y: 1100 },
    "SA": { x: 2400, y: 1100 },
    "TR": { x: 3600, y: 1100 },
    "EG": { x: 4800, y: 1100 },
    "AE": { x: 6000, y: 1100 }
};

let activePlayers = {}; 
let standVault = {};    

function calculateRadius(points) {
    const base = 35;
    const val = Math.max(0, Number(points) || 0);
    const dynamicSize = Math.log10(val + 1) * 15;
    return Math.min(120, Math.max(base, base + dynamicSize));
}

function calculateSpeed(radius) {
    return Math.max(0.05, 0.25 - (radius / 500));
}

function getCountryFlag(code) {
    const flags = { "SY": "🇸🇾", "SA": "🇸🇦", "TR": "🇹🇷", "EG": "🇪🇬", "AE": "🇦🇪" };
    return flags[code] || "🚩";
}

async function loadOfflinePlayersToStands() {
    if (!supabase) return;
    try {
        const { data: users, error } = await supabase
            .from('profiles')
            .select('id, display_name, username, points_balance, tier, country_code')
            .limit(100);

        if (users && !error) {
            users.forEach(u => {
                const country = u.country_code || 'SY';
                const stand = STAND_LOCATIONS[country] || STAND_LOCATIONS['SY'];
                const balance = Number(u.points_balance || 0);

                standVault[u.id] = {
                    id: u.id,
                    name: u.display_name || u.username || 'لاعب',
                    points: balance,
                    tier: u.tier || 'Bronze',
                    inStand: true,
                    x: stand.x + (Math.random() * 400 - 200),
                    y: stand.y + (Math.random() * 200 - 100),
                    radius: calculateRadius(balance),
                    country: { code: country, flag: getCountryFlag(country) }
                };
            });
            console.log(` تم تحميل ${Object.keys(standVault).length} لاعب للمدرجات.`);
        }
    } catch (err) {
        console.error("خطأ جلب بيانات Supabase:", err);
    }
}

// دالة لتحديث الرصيد في Supabase مباشرة عند الابتلاع
async function syncUserPointsToDB(userId, newPoints) {
    if (!supabase || !userId || userId.startsWith('guest_')) return;
    try {
        await supabase
            .from('profiles')
            .update({ points_balance: newPoints })
            .eq('id', userId);
    } catch (e) {
        console.error("فشل تحديث قاعدة البيانات:", e);
    }
}

loadOfflinePlayersToStands();

function heartbeat() {
    this.isAlive = true;
}

wss.on('connection', async (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    const urlParams = new URLSearchParams(req.url.replace(/^.*\?/, ''));
    const userId = urlParams.get('userId');
    const socketId = (userId && !userId.startsWith('guest_')) 
        ? userId 
        : 'guest_' + Math.random().toString(36).substr(2, 7);

    ws.id = socketId;

    let profileData = null;
    if (supabase && userId && !userId.startsWith('guest_')) {
        const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
        profileData = data;
    }

    const balance = Number(profileData?.points_balance || 0);
    const country = profileData?.country_code || 'SY';

    let player = standVault[socketId] || {
        id: socketId,
        name: profileData?.display_name || profileData?.username || (socketId.startsWith('guest_') ? `زائر_${socketId.slice(-4)}` : 'لاعب'),
        points: balance,
        tier: profileData?.tier || 'Bronze',
        country: { code: country, flag: getCountryFlag(country) },
        x: 3600,
        y: 3700,
        radius: calculateRadius(balance)
    };

    delete standVault[socketId];
    player.inStand = false;
    player.targetX = player.x;
    player.targetY = player.y;

    activePlayers[socketId] = player;

    ws.send(JSON.stringify({ type: 'INIT', selfId: socketId }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // عند رغبة اللاعب المبتلع بالعودة إلى الميدان
            if (data.type === 'REENTER_ARENA') {
                if (standVault[socketId]) {
                    let p = standVault[socketId];
                    delete standVault[socketId];
                    p.inStand = false;
                    p.x = 3600 + (Math.random() * 400 - 200);
                    p.y = 3700 + (Math.random() * 400 - 200);
                    p.targetX = p.x;
                    p.targetY = p.y;
                    activePlayers[socketId] = p;
                }
            } else if (data.type === 'TARGET') {
                const current = activePlayers[socketId];
                if (current && typeof data.x === 'number' && typeof data.y === 'number') {
                    const r = current.radius || 35;
                    current.targetX = Math.max(PITCH_BOUNDS.minX + r, Math.min(PITCH_BOUNDS.maxX - r, data.x));
                    current.targetY = Math.max(PITCH_BOUNDS.minY + r, Math.min(PITCH_BOUNDS.maxY - r, data.y));
                }
            }
        } catch (e) {
            console.error("خطأ معالجة رسالة WebSocket:", e);
        }
    });

    ws.on('close', () => {
        if (activePlayers[socketId]) {
            const disconnectedPlayer = activePlayers[socketId];
            delete activePlayers[socketId];

            disconnectedPlayer.inStand = true;
            const stand = STAND_LOCATIONS[disconnectedPlayer.country?.code] || STAND_LOCATIONS['SY'];
            disconnectedPlayer.x = stand.x + (Math.random() * 200 - 100);
            disconnectedPlayer.y = stand.y + (Math.random() * 100 - 50);
            standVault[socketId] = disconnectedPlayer;
        }
    });
});

// خوارزمية الابتلاع والمواجهة في الميدان
function checkCollisions() {
    const players = Object.values(activePlayers);
    
    for (let i = 0; i < players.length; i++) {
        for (let j = 0; j < players.length; j++) {
            if (i === j) continue;

            const p1 = players[i];
            const p2 = players[j];

            if (!p1 || !p2) continue;

            const dx = p1.x - p2.x;
            const dy = p1.y - p2.y;
            const distance = Math.hypot(dx, dy);

            // الشرط: أن تكون الكرة 1 أكبر حسائباً بـ 1.15 من الكرة 2 والمسافة بين المركزين أقرب من نصف قطر الكبيرة
            if (p1.radius > p2.radius * 1.15 && distance < p1.radius) {
                
                // 1. زيادة الكبيرة بنقطة واحدة
                p1.points += 1;
                p1.radius = calculateRadius(p1.points);
                syncUserPointsToDB(p1.id, p1.points);

                // 2. خفض نقطة من الصغيرة
                p2.points = Math.max(0, p2.points - 1);
                p2.radius = calculateRadius(p2.points);
                syncUserPointsToDB(p2.id, p2.points);

                // 3. طرد الكرة الصغيرة من الميدان إلى المدرج
                delete activePlayers[p2.id];
                p2.inStand = true;

                const stand = STAND_LOCATIONS[p2.country?.code] || STAND_LOCATIONS['SY'];
                p2.x = stand.x + (Math.random() * 200 - 100);
                p2.y = stand.y + (Math.random() * 100 - 50);
                standVault[p2.id] = p2;

                // إعلام العميل الصغير بإخراجه وإمكانية الضغط للعودة
                wss.clients.forEach(client => {
                    if (client.id === p2.id && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'EATEN',
                            eatenBy: p1.name,
                            remainingPoints: p2.points
                        }));
                    }
                });
            }
        }
    }
}

const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

// حلقة الفيزياء، الابتلاع والتزامن (30 FPS)
setInterval(() => {
    // 1. التحديث الفيزيائي للمواقع
    Object.values(activePlayers).forEach(p => {
        if (typeof p.targetX === 'number' && typeof p.targetY === 'number') {
            const speed = calculateSpeed(p.radius);
            p.x += (p.targetX - p.x) * speed;
            p.y += (p.targetY - p.y) * speed;
        }
    });

    // 2. فحص ومعالجة عمليات الابتلاع والتصادمات
    checkCollisions();

    // 3. بث الحالة العامة المحدثة
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
server.listen(PORT, () => console.log(`🚀 Agario Arena Server with Eating Logic running on port ${PORT}`));