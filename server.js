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

// حدود المضمار الداخلي
const PITCH_BOUNDS = { minX: 500, maxX: 6700, minY: 1900, maxY: 5500 };

// مواقع المدرجات (خارج حدود المضمار)
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
    const val = Math.max(0, Number(points) || 0);
    const calculatedRadius = 30 + Math.pow(val / 10, 0.55);
    return Math.min(600, Math.max(30, calculatedRadius));
}

function calculateSpeed(radius) {
    return Math.max(0.02, 0.22 - (radius / 1200));
}

function getCountryFlag(code) {
    const flags = { "SY": "🇸🇾", "SA": "🇸🇦", "TR": "🇹🇷", "EG": "🇪🇬", "AE": "🇦🇪" };
    return flags[code] || "🚩";
}

// دالة لتوليد إحداثيات مضمونة خارج المضمار عند الابتلاع
function getRandomOffPitchPosition(countryCode) {
    const stand = STAND_LOCATIONS[countryCode] || STAND_LOCATIONS['SY'];
    return {
        x: stand.x + (Math.random() * 300 - 150),
        y: stand.y + (Math.random() * 150 - 75)
    };
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
                const pos = getRandomOffPitchPosition(country);
                const balance = Number(u.points_balance || 0);

                standVault[u.id] = {
                    id: u.id,
                    name: u.display_name || u.username || 'لاعب',
                    points: balance,
                    tier: u.tier || 'Bronze',
                    inStand: true,
                    x: pos.x,
                    y: pos.y,
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

async function updatePointsSafely(userId, delta) {
    if (!supabase || !userId || userId.startsWith('guest_')) return;
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('points_balance')
            .eq('id', userId)
            .single();

        if (error || !data) return;

        const currentDbBalance = Number(data.points_balance || 0);
        const newBalance = Math.max(0, currentDbBalance + delta);

        await supabase
            .from('profiles')
            .update({ points_balance: newBalance })
            .eq('id', userId);

        if (activePlayers[userId]) {
            activePlayers[userId].points = newBalance;
            activePlayers[userId].radius = calculateRadius(newBalance);
        } else if (standVault[userId]) {
            standVault[userId].points = newBalance;
            standVault[userId].radius = calculateRadius(newBalance);
        }
    } catch (e) {
        console.error("فشل التحديث الآمن لقاعدة البيانات:", e);
    }
}

setInterval(async () => {
    if (!supabase) return;
    const activeIds = Object.keys(activePlayers).filter(id => !id.startsWith('guest_'));
    if (activeIds.length === 0) return;

    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('id, points_balance')
            .in('id', activeIds.slice(0, 500));

        if (data && !error) {
            data.forEach(user => {
                if (activePlayers[user.id]) {
                    const realBalance = Number(user.points_balance || 0);
                    if (activePlayers[user.id].points !== realBalance) {
                        activePlayers[user.id].points = realBalance;
                        activePlayers[user.id].radius = calculateRadius(realBalance);
                    }
                }
            });
        }
    } catch (err) {
        console.error("خطأ المزامنة الحية للأرصدة:", err);
    }
}, 5000);

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
                    const r = current.radius || 30;
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
            const pos = getRandomOffPitchPosition(disconnectedPlayer.country?.code);
            disconnectedPlayer.x = pos.x;
            disconnectedPlayer.y = pos.y;
            standVault[socketId] = disconnectedPlayer;
        }
    });
});

function checkCollisions() {
    const players = Object.values(activePlayers);
    
    for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
            const p1 = players[i];
            const p2 = players[j];

            if (!p1 || !p2) continue;

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const distance = Math.hypot(dx, dy) || 1;

            if (p1.radius > p2.radius * 1.01 && distance < (p1.radius * 0.45)) {
                executeEat(p1, p2);
            } 
            else if (p2.radius > p1.radius * 1.01 && distance < (p2.radius * 0.45)) {
                executeEat(p2, p1);
            }
        }
    }
}

// 🎯 عند الابتلاع: نقل الضحية فوراً لخارج المضمار (المدرجات)
function executeEat(predator, victim) {
    predator.points += 1;
    predator.radius = calculateRadius(predator.points);
    victim.points = Math.max(0, victim.points - 1);
    victim.radius = calculateRadius(victim.points);

    updatePointsSafely(predator.id, 1);
    updatePointsSafely(victim.id, -1);

    delete activePlayers[victim.id];
    victim.inStand = true;

    // الحصول على موقع جديد خارج حدود الملعب تماماً
    const offPitchPos = getRandomOffPitchPosition(victim.country?.code);
    victim.x = offPitchPos.x;
    victim.y = offPitchPos.y;
    victim.targetX = offPitchPos.x;
    victim.targetY = offPitchPos.y;

    standVault[victim.id] = victim;

    wss.clients.forEach(client => {
        if (client.id === victim.id && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'EATEN',
                eatenBy: predator.name,
                remainingPoints: victim.points
            }));
        }
    });
}

const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

setInterval(() => {
    Object.values(activePlayers).forEach(p => {
        if (typeof p.targetX === 'number' && typeof p.targetY === 'number') {
            const speed = calculateSpeed(p.radius);
            p.x += (p.targetX - p.x) * speed;
            p.y += (p.targetY - p.y) * speed;
        }
    });

    checkCollisions();

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
server.listen(PORT, () => console.log(`🚀 Agario Server with Off-Pitch Eaten Respawn running on port ${PORT}`));