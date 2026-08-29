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

const PITCH_BOUNDS = { minX: 0, maxX: 14000, minY: 0, maxY: 8000 };

let incentivePool = 0; 
let botCounter = 0;

const STAND_LOCATIONS = {
    "SY": { x: 3500,  y: -500,  width: 2500, height: 400, edge: 'TOP' },
    "TR": { x: 10500, y: -500,  width: 2500, height: 400, edge: 'TOP' },
    "SA": { x: 3500,  y: 8500,  width: 2500, height: 400, edge: 'BOTTOM' },
    "EG": { x: 10500, y: 8500,  width: 2500, height: 400, edge: 'BOTTOM' },
    "AE": { x: 14500, y: 4000,  width: 400,  height: 2500, edge: 'RIGHT' }
};

const COUNTRY_DATA = {
    "SY": { name: "سوريا", flag: "🇸🇾", image: "/flags/sy.png" },
    "SA": { name: "السعودية", flag: "🇸🇦", image: "/flags/sa.png" },
    "TR": { name: "تركيا", flag: "🇹🇷", image: "/flags/tr.png" },
    "EG": { name: "مصر", flag: "🇪🇬", image: "/flags/eg.png" },
    "AE": { name: "الإمارات", flag: "🇦🇪", image: "/flags/ae.png" }
};

let activePlayers = {}; 
let standVault = {};     

const BOT_NAMES = ['Ghost_Hunter', 'Shadow_King', 'Vortex_99', 'Neon_Blade', 'Zeus_BOY', 'Alpha_Wolf', 'Storm_Rider', 'Titan_X', 'Cyber_Samurai', 'Phantom_Lord', 'Odin_King', 'Valkyrie_X', 'Apex_Predator', 'Blaze_Strike', 'Omega_Prime'];
const COUNTRIES = ['SY', 'SA', 'TR', 'EG', 'AE'];

function calculateRadius(points) {
    const val = Math.max(0, Number(points) || 0);
    const calculatedRadius = 60 + (Math.pow(val, 0.55) * 16);
    return Math.min(1200, Math.max(60, Math.round(calculatedRadius)));
}

function getBotMoveSpeed(radius) {
    return Math.max(4, 12 - (radius / 100));
}

function getPlayerSpeedFactor(radius) {
    return Math.max(0.04, 0.12 - (radius / 3000));
}

function getCountryInfo(code) {
    const data = COUNTRY_DATA[code] || COUNTRY_DATA['SY'];
    return {
        code: code || 'SY',
        flag: data.flag,
        flagImage: data.image
    };
}

function isGuestPlayer(player) {
    return !player || String(player.id).startsWith('guest_');
}

function getRandomOnPitchPosition(radius) {
    const r = radius || 60;
    const minX = PITCH_BOUNDS.minX + r;
    const maxX = PITCH_BOUNDS.maxX - r;
    const minY = PITCH_BOUNDS.minY + r;
    const maxY = PITCH_BOUNDS.maxY - r;

    return {
        x: Math.floor(Math.random() * (maxX - minX)) + minX,
        y: Math.floor(Math.random() * (maxY - minY)) + minY
    };
}

function getStandTotals() {
    const totals = { "SY": 0, "SA": 0, "TR": 0, "EG": 0, "AE": 0 };
    
    Object.values(activePlayers).forEach(p => {
        const code = p.country?.code || 'SY';
        if (totals[code] !== undefined) {
            totals[code] += (p.points || 0);
        }
    });

    Object.values(standVault).forEach(p => {
        const code = p.country?.code || 'SY';
        if (totals[code] !== undefined) {
            totals[code] += (p.points || 0);
        }
    });

    return totals;
}

function spawnBotFromPool(initialPoints = 10) {
    botCounter++;
    const botId = `bot_pool_${botCounter}`;
    const randomName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    const randomCountry = COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
    
    const radius = calculateRadius(initialPoints);
    const pos = getRandomOnPitchPosition(radius);
    const initialAngle = Math.random() * Math.PI * 2;

    activePlayers[botId] = {
        id: botId,
        isBot: true,
        name: randomName,
        points: initialPoints,
        tier: 'Gold',
        country: getCountryInfo(randomCountry),
        x: pos.x,
        y: pos.y,
        vx: Math.cos(initialAngle),
        vy: Math.sin(initialAngle),
        changeTimer: Math.floor(Math.random() * 60) + 30,
        radius: radius,
        isProtected: true,
        protectedUntil: Date.now() + 5000
    };
}

function checkIncentivePool() {
    while (incentivePool >= 10) {
        incentivePool -= 10;
        spawnBotFromPool(10);
    }
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
                const balance = Number(u.points_balance || 0);

                standVault[u.id] = {
                    id: u.id,
                    name: u.display_name || u.username || 'لاعب',
                    points: balance,
                    tier: u.tier || 'Bronze',
                    inStand: true,
                    country: getCountryInfo(country)
                };
            });
        }
    } catch (err) {
        console.error("خطأ جلب بيانات Supabase:", err);
    }
}

async function updatePointsSafely(userId, delta) {
    if (!supabase || !userId || userId.startsWith('guest_') || userId.startsWith('bot_')) return;
    
    if (activePlayers[userId]) {
        activePlayers[userId].points = Math.max(0, (activePlayers[userId].points || 0) + delta);
        activePlayers[userId].radius = calculateRadius(activePlayers[userId].points);
    } else if (standVault[userId]) {
        standVault[userId].points = Math.max(0, (standVault[userId].points || 0) + delta);
    }

    try {
        const { error } = await supabase.rpc('change_user_points', {
            user_id: userId,
            delta: delta
        });

        if (error) console.error("خطأ RPC في Supabase:", error.message);
    } catch (e) {
        console.error("فشل اتصال تحديث الرصيد بقاعدة البيانات:", e);
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
    const selectedCountry = urlParams.get('country') || 'SY';

    const socketId = (userId && !userId.startsWith('guest_')) 
        ? userId 
        : 'guest_' + Math.random().toString(36).substr(2, 7);

    ws.id = socketId;

    let profileData = null;
    if (supabase && userId && !userId.startsWith('guest_')) {
        const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
        profileData = data;
    }

    const isGuest = socketId.startsWith('guest_');
    const balance = isGuest ? 10 : Number(profileData?.points_balance || 0);
    const country = profileData?.country_code || selectedCountry;
    const initRadius = calculateRadius(balance);
    const initialSpawn = getRandomOnPitchPosition(initRadius);

    let player = standVault[socketId] || {
        id: socketId,
        name: profileData?.display_name || profileData?.username || (isGuest ? `زائر_${socketId.slice(-4)}` : 'لاعب'),
        points: balance,
        tier: profileData?.tier || 'Bronze',
        country: getCountryInfo(country),
        x: initialSpawn.x,
        y: initialSpawn.y,
        radius: initRadius
    };

    delete standVault[socketId];
    player.inStand = false;
    player.isBot = false;
    player.targetX = player.x;
    player.targetY = player.y;
    player.isProtected = true;
    player.protectedUntil = Date.now() + 5000;

    activePlayers[socketId] = player;

    ws.send(JSON.stringify({ 
        type: 'INIT', 
        selfId: socketId,
        standLocations: STAND_LOCATIONS,
        pitchBounds: PITCH_BOUNDS
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'REENTER_ARENA') {
                if (standVault[socketId]) {
                    let p = standVault[socketId];
                    delete standVault[socketId];

                    if (isGuestPlayer(p)) p.points = 10;
                    p.radius = calculateRadius(p.points);

                    const spawnPos = getRandomOnPitchPosition(p.radius || 60);
                    
                    p.inStand = false;
                    p.x = spawnPos.x;
                    p.y = spawnPos.y;
                    p.targetX = spawnPos.x;
                    p.targetY = spawnPos.y;
                    p.isProtected = true;
                    p.protectedUntil = Date.now() + 5000;
                    
                    activePlayers[socketId] = p;
                }
            } else if (data.type === 'TARGET') {
                const current = activePlayers[socketId];
                if (current && typeof data.x === 'number' && typeof data.y === 'number') {
                    const r = current.radius || 60;
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
            standVault[socketId] = disconnectedPlayer;
        }
    });
});

const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(pingInterval);
});

function checkCollisions() {
    const players = Object.values(activePlayers);
    const count = players.length;
    const now = Date.now();
    
    for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
            const p1 = players[i];
            const p2 = players[j];

            if (!p1 || !p2) continue;
            
            if ((p1.isProtected && now < p1.protectedUntil) || (p2.isProtected && now < p2.protectedUntil)) {
                continue;
            }

            if (p1.isBot && p2.isBot) continue;

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const distance = Math.hypot(dx, dy) || 1;

            const maxRadius = Math.max(p1.radius, p2.radius);
            const minOverlapDist = maxRadius * 0.5; 
            
            if (distance < minOverlapDist) {
                let predator = null;
                let victim = null;

                if ((p1.points || 0) > (p2.points || 0)) {
                    predator = p1; victim = p2;
                } else if ((p2.points || 0) > (p1.points || 0)) {
                    predator = p2; victim = p1;
                }

                if (predator && victim) {
                    if (isGuestPlayer(victim) && !predator.isBot) {
                        continue; 
                    }
                    executeEat(predator, victim);
                }
            }
        }
    }
}

function executeEat(predator, victim) {
    const delta = 1;

    if (isGuestPlayer(predator)) {
        incentivePool += delta; 
        checkIncentivePool();   
    } else if (!predator.isBot) {
        updatePointsSafely(predator.id, delta);
    } else {
        predator.points = (predator.points || 0) + delta;
        predator.radius = calculateRadius(predator.points);
    }

    if (!victim.isBot && !isGuestPlayer(victim)) {
        updatePointsSafely(victim.id, -delta);
    } else {
        victim.points = Math.max(0, (victim.points || 0) - delta);
        victim.radius = calculateRadius(victim.points);
    }

    if (victim.points <= 0 || victim.isBot) {
        if (victim.isBot) {
            delete activePlayers[victim.id];
        } else {
            delete activePlayers[victim.id];
            victim.inStand = true;

            standVault[victim.id] = victim;

            wss.clients.forEach(client => {
                if (client.id === victim.id && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'EATEN',
                        eatenBy: predator.name,
                        lostPoints: delta,
                        remainingPoints: victim.points
                    }));
                }
            });
        }
    }
}

setInterval(() => {
    const allEntities = Object.values(activePlayers);
    const now = Date.now();

    allEntities.forEach(p => {
        const r = p.radius || 60;

        if (p.isProtected && now >= p.protectedUntil) {
            p.isProtected = false;
        }

        if (p.isBot) {
            let fleeX = 0;
            let fleeY = 0;
            let chaseX = 0;
            let chaseY = 0;
            let dangerFound = false;
            let targetFound = false;

            for (let other of allEntities) {
                if (other.id === p.id || other.isBot) continue;

                const dx = other.x - p.x;
                const dy = other.y - p.y;
                const dist = Math.hypot(dx, dy);

                if ((other.points || 0) > (p.points || 0)) {
                    const safeDistance = p.radius + other.radius + 500;
                    if (dist < safeDistance && dist > 0) {
                        dangerFound = true;
                        const force = (safeDistance - dist) / safeDistance;
                        fleeX -= (dx / dist) * force;
                        fleeY -= (dy / dist) * force;
                    }
                } 
                else if ((p.points || 0) > (other.points || 0) && !other.isProtected) {
                    const huntDistance = 800;
                    if (dist < huntDistance && dist > 0) {
                        targetFound = true;
                        chaseX += (dx / dist);
                        chaseY += (dy / dist);
                    }
                }
            }

            if (dangerFound) {
                const len = Math.hypot(fleeX, fleeY) || 1;
                p.vx = (p.vx * 0.6) + ((fleeX / len) * 0.4);
                p.vy = (p.vy * 0.6) + ((fleeY / len) * 0.4);
            } else if (targetFound) {
                const len = Math.hypot(chaseX, chaseY) || 1;
                p.vx = (p.vx * 0.7) + ((chaseX / len) * 0.3);
                p.vy = (p.vy * 0.7) + ((chaseY / len) * 0.3);
            } else {
                p.changeTimer--;
                if (p.changeTimer <= 0) {
                    const randomAngle = Math.random() * Math.PI * 2;
                    p.targetVx = Math.cos(randomAngle);
                    p.targetVy = Math.sin(randomAngle);
                    p.changeTimer = Math.floor(Math.random() * 90) + 40;
                }
                if (p.targetVx !== undefined) {
                    p.vx = (p.vx * 0.95) + (p.targetVx * 0.05);
                    p.vy = (p.vy * 0.95) + (p.targetVy * 0.05);
                }
            }

            const moveLen = Math.hypot(p.vx, p.vy) || 1;
            p.vx /= moveLen;
            p.vy /= moveLen;

            const botSpeed = getBotMoveSpeed(r);
            p.x += p.vx * botSpeed;
            p.y += p.vy * botSpeed;

            if (p.x <= PITCH_BOUNDS.minX + r) {
                p.x = PITCH_BOUNDS.minX + r;
                p.vx = Math.abs(p.vx);
            } else if (p.x >= PITCH_BOUNDS.maxX - r) {
                p.x = PITCH_BOUNDS.maxX - r;
                p.vx = -Math.abs(p.vx);
            }

            if (p.y <= PITCH_BOUNDS.minY + r) {
                p.y = PITCH_BOUNDS.minY + r;
                p.vy = Math.abs(p.vy);
            } else if (p.y >= PITCH_BOUNDS.maxY - r) {
                p.y = PITCH_BOUNDS.maxY - r;
                p.vy = -Math.abs(p.vy);
            }

            p.targetX = p.x;
            p.targetY = p.y;
        } else {
            if (typeof p.targetX === 'number' && typeof p.targetY === 'number') {
                const dx = p.targetX - p.x;
                const dy = p.targetY - p.y;
                const dist = Math.hypot(dx, dy);

                if (dist > 5) {
                    const speedFactor = getPlayerSpeedFactor(r);
                    p.x += dx * speedFactor;
                    p.y += dy * speedFactor;
                }

                p.x = Math.max(PITCH_BOUNDS.minX + r, Math.min(PITCH_BOUNDS.maxX - r, p.x));
                p.y = Math.max(PITCH_BOUNDS.minY + r, Math.min(PITCH_BOUNDS.maxY - r, p.y));
            }
        }
    });

    checkCollisions();

    const payload = JSON.stringify({
        type: 'SYNC',
        activePlayers,
        standLocations: STAND_LOCATIONS,
        standTotals: getStandTotals(),
        incentivePool: incentivePool
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));