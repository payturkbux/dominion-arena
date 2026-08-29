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

const BOT_NAMES = ['Ghost_Hunter', 'Shadow_King', 'Vortex_99', 'Neon_Blade', 'Zeus_BOY', 'Alpha_Wolf', 'Storm_Rider', 'Titan_X'];
const COUNTRIES = ['SY', 'SA', 'TR', 'EG', 'AE'];

function calculateRadius(points) {
    const val = Math.max(0, Number(points) || 0);
    const calculatedRadius = 30 + (Math.pow(val, 0.55) * 8);
    return Math.min(300, Math.max(30, Math.round(calculatedRadius)));
}

// 📱 سرعة متزنة ومناسبة جداً لإصبع الهاتف
function calculateSpeed(radius) {
    return Math.max(0.025, 0.075 - (radius / 3000));
}

function getCountryFlag(code) {
    const flags = { "SY": "🇸🇾", "SA": "🇸🇦", "TR": "🇹🇷", "EG": "🇪🇬", "AE": "🇦🇪" };
    return flags[code] || "🚩";
}

function getRandomOffPitchPosition(countryCode) {
    const stand = STAND_LOCATIONS[countryCode] || STAND_LOCATIONS['SY'];
    return {
        x: stand.x + (Math.random() * 300 - 150),
        y: stand.y + (Math.random() * 150 - 75)
    };
}

function getRandomOnPitchPosition(radius) {
    const margin = radius + 50;
    return {
        x: Math.floor(Math.random() * (PITCH_BOUNDS.maxX - PITCH_BOUNDS.minX - 2 * margin)) + PITCH_BOUNDS.minX + margin,
        y: Math.floor(Math.random() * (PITCH_BOUNDS.maxY - PITCH_BOUNDS.minY - 2 * margin)) + PITCH_BOUNDS.minY + margin
    };
}

function spawnBot(botId) {
    const randomName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    const randomCountry = COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
    
    const randomInitialPoints = Math.floor(Math.random() * 16);
    const radius = calculateRadius(randomInitialPoints);
    const pos = getRandomOnPitchPosition(radius);

    activePlayers[botId] = {
        id: botId,
        isBot: true,
        name: randomName,
        points: randomInitialPoints,
        eatenPool: 0,
        tier: 'Gold',
        country: { code: randomCountry, flag: getCountryFlag(randomCountry) },
        x: pos.x,
        y: pos.y,
        targetX: pos.x,
        targetY: pos.y,
        radius: radius
    };
}

for (let i = 1; i <= 6; i++) {
    spawnBot(`bot_${i}`);
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
        }
    } catch (err) {
        console.error("خطأ جلب بيانات Supabase:", err);
    }
}

async function updatePointsSafely(userId, delta) {
    if (!supabase || !userId || userId.startsWith('guest_') || userId.startsWith('bot_')) return;
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
    const initRadius = calculateRadius(balance);
    const initialSpawn = getRandomOnPitchPosition(initRadius);

    let player = standVault[socketId] || {
        id: socketId,
        name: profileData?.display_name || profileData?.username || (socketId.startsWith('guest_') ? `زائر_${socketId.slice(-4)}` : 'لاعب'),
        points: balance,
        tier: profileData?.tier || 'Bronze',
        country: { code: country, flag: getCountryFlag(country) },
        x: initialSpawn.x,
        y: initialSpawn.y,
        radius: initRadius
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
                    
                    const spawnPos = getRandomOnPitchPosition(p.radius || 30);
                    
                    p.inStand = false;
                    p.x = spawnPos.x;
                    p.y = spawnPos.y;
                    p.targetX = spawnPos.x;
                    p.targetY = spawnPos.y;
                    
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

            if (distance < (Math.max(p1.radius, p2.radius) * 0.45)) {
                
                if (p1.radius > p2.radius * 1.03) {
                    if (p2.isBot && (p2.eatenPool || 0) < 2) {
                        continue;
                    }
                    executeEat(p1, p2);
                } 
                else if (p2.radius > p1.radius * 1.03) {
                    if (p1.isBot && (p1.eatenPool || 0) < 2) {
                        continue;
                    }
                    executeEat(p2, p1);
                }
            }
        }
    }
}

function executeEat(predator, victim) {
    if (predator.isBot) {
        predator.eatenPool = (predator.eatenPool || 0) + 1;
        predator.points += 2;
        predator.radius = calculateRadius(predator.points);
    } else {
        predator.points += 1;
        predator.radius = calculateRadius(predator.points);
        updatePointsSafely(predator.id, 1);
    }

    if (victim.isBot) {
        const botId = victim.id;
        delete activePlayers[botId];
        setTimeout(() => spawnBot(botId), 3000); 
    } else {
        victim.points = Math.max(0, victim.points - 1);
        victim.radius = calculateRadius(victim.points);
        updatePointsSafely(victim.id, -1);

        delete activePlayers[victim.id];
        victim.inStand = true;

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
}

// 🎯 معالجة الحركة لمنع الاهتزاز عند التلامس
setInterval(() => {
    Object.values(activePlayers).forEach(p => {
        if (p.isBot) {
            if (Math.random() < 0.02 || Math.hypot(p.targetX - p.x, p.targetY - p.y) < 60) {
                const target = getRandomOnPitchPosition(p.radius);
                p.targetX = target.x;
                p.targetY = target.y;
            }
        }

        if (typeof p.targetX === 'number' && typeof p.targetY === 'number') {
            const dx = p.targetX - p.x;
            const dy = p.targetY - p.y;
            const dist = Math.hypot(dx, dy);

            // Dead-zone: إذا كان إصبع اللاعب قريباً جداً من مركز الكرة (أقل من 10px)، تتوقف الكرة لإنهاء الاهتزاز
            if (dist > 10) {
                const speedFactor = calculateSpeed(p.radius);
                p.x += dx * speedFactor;
                p.y += dy * speedFactor;
            }
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
server.listen(PORT, () => console.log(`🚀 Agario Mobile-Optimized Server running on port ${PORT}`));