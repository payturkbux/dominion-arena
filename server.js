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

const ADMIN_SECRET = process.env.ADMIN_SECRET || "Ezkyaa.2012.2013";

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

const PITCH_BOUNDS = { minX: 0, maxX: 140000, minY: 0, maxY: 80000 };

let incentivePool = 0; 
let incentiveTarget = 10;
let botCounter = 0;

const STAND_LOCATIONS = {
    "SY": { x: 15000,  y: -12000, size: 20000, edge: 'TOP' },
    "SA": { x: 42000,  y: -12000, size: 20000, edge: 'TOP' },
    "TR": { x: 70000,  y: -12000, size: 20000, edge: 'TOP' },
    "EG": { x: 98000,  y: -12000, size: 20000, edge: 'TOP' },
    "AE": { x: 125000, y: -12000, size: 20000, edge: 'TOP' },

    "QA": { x: 15000,  y: 92000,  size: 20000, edge: 'BOTTOM' },
    "KW": { x: 42000,  y: 92000,  size: 20000, edge: 'BOTTOM' },
    "IQ": { x: 70000,  y: 92000,  size: 20000, edge: 'BOTTOM' },
    "JO": { x: 98000,  y: 92000,  size: 20000, edge: 'BOTTOM' },
    "LB": { x: 125000, y: 92000,  size: 20000, edge: 'BOTTOM' },

    "OM": { x: 152000, y: 5000,   size: 20000, edge: 'RIGHT' },
    "BH": { x: 152000, y: 28000,  size: 20000, edge: 'RIGHT' },
    "MA": { x: 152000, y: 52000,  size: 20000, edge: 'RIGHT' },
    "DZ": { x: 152000, y: 75000,  size: 20000, edge: 'RIGHT' },

    "TN": { x: -12000, y: 5000,   size: 20000, edge: 'LEFT' },
    "LY": { x: -12000, y: 28000,  size: 20000, edge: 'LEFT' },
    "SD": { x: -12000, y: 52000,  size: 20000, edge: 'LEFT' },
    "YE": { x: -12000, y: 75000,  size: 20000, edge: 'LEFT' },

    "PS": { x: -12000, y: -12000, size: 20000, edge: 'TOP_LEFT' },
    "US": { x: 152000, y: -12000, size: 20000, edge: 'TOP_RIGHT' }
};

const COUNTRY_DATA = {
    "SY": { name: "سوريا", flag: "🇸🇾" },
    "SA": { name: "السعودية", flag: "🇸🇦" },
    "TR": { name: "تركيا", flag: "🇹🇷" },
    "EG": { name: "مصر", flag: "🇪🇬" },
    "AE": { name: "الإمارات", flag: "🇦🇪" },
    "QA": { name: "قطر", flag: "🇶🇦" },
    "KW": { name: "الكويت", flag: "🇰🇼" },
    "IQ": { name: "العراق", flag: "🇮🇶" },
    "JO": { name: "الأردن", flag: "🇯🇴" },
    "LB": { name: "لبنان", flag: "🇱🇧" },
    "OM": { name: "عُمان", flag: "🇴🇲" },
    "BH": { name: "البحرين", flag: "🇧🇭" },
    "MA": { name: "المغرب", flag: "🇲🇦" },
    "DZ": { name: "الجزائر", flag: "🇩🇿" },
    "TN": { name: "تونس", flag: "🇹🇳" },
    "LY": { name: "ليبيا", flag: "🇱🇾" },
    "SD": { name: "السودان", flag: "🇸🇩" },
    "YE": { name: "اليمن", flag: "🇾🇪" },
    "PS": { name: "فلسطين", flag: "🇵🇸" },
    "US": { name: "أمريكا", flag: "🇺🇸" }
};

let activePlayers = {}; 
let standVault = {};     
let userWallets = {};

const BOT_NAMES = ['Ghost_Hunter', 'Shadow_King', 'Vortex_99', 'Neon_Blade', 'Zeus_BOY', 'Alpha_Wolf', 'Storm_Rider', 'Titan_X', 'Cyber_Samurai', 'Phantom_Lord', 'Odin_King', 'Valkyrie_X', 'Apex_Predator', 'Blaze_Strike', 'Omega_Prime'];
const COUNTRIES = Object.keys(COUNTRY_DATA);

function calculateRadius(points) {
    const val = Math.max(0, Number(points) || 0);
    const calculatedRadius = 60 + (Math.pow(val, 0.55) * 16);
    return Math.min(3000, Math.max(60, Math.round(calculatedRadius)));
}

function getBotMoveSpeed(radius) {
    return Math.max(15, 45 - (radius / 100));
}

function getPlayerSpeedFactor(radius) {
    return Math.max(0.04, 0.12 - (radius / 10000));
}

function getCountryInfo(code) {
    const data = COUNTRY_DATA[code] || COUNTRY_DATA['SY'];
    return {
        code: code || 'SY',
        flag: data.flag
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
    const totals = {};
    COUNTRIES.forEach(c => totals[c] = 0);
    
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
    while (incentivePool >= incentiveTarget) {
        incentivePool -= incentiveTarget;
        spawnBotFromPool(incentiveTarget);
    }
}

async function loadOfflinePlayersToStands() {
    if (!supabase) return;
    try {
        const { data: users, error } = await supabase
            .from('profiles')
            .select('id, display_name, username, points_balance, pwr, tier, country_code')
            .limit(100);

        if (users && !error) {
            users.forEach(u => {
                const country = u.country_code || 'SY';

                standVault[u.id] = {
                    id: u.id,
                    name: u.display_name || u.username || 'لاعب',
                    points: Number(u.pwr) || 0,
                    tier: u.tier || 'Bronze',
                    inStand: true,
                    country: getCountryInfo(country)
                };

                userWallets[u.id] = Number(u.points_balance) || 0;
            });
        }
    } catch (err) {
        console.error("خطأ جلب بيانات Supabase:", err);
    }
}

async function updateDatabaseBalanceSafely(userId, newBalance, pwr) {
    if (!supabase || !userId || userId.startsWith('guest_') || userId.startsWith('bot_')) return;

    try {
        const updateObj = {};
        if (newBalance !== undefined && newBalance !== null) updateObj.points_balance = newBalance;
        if (pwr !== undefined && pwr !== null) updateObj.pwr = pwr;

        if (Object.keys(updateObj).length === 0) return;

        const { error } = await supabase
            .from('profiles')
            .update(updateObj)
            .eq('id', userId);

        if (error) console.error("خطأ تحديث المحفظة/الطاقة في Supabase:", error.message);
    } catch (e) {
        console.error("فشل اتصال تحديث قاعدة البيانات:", e);
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
    const selectedCountry = urlParams.get('country');

    const socketId = (userId && !userId.startsWith('guest_')) 
        ? userId 
        : (userId || ('guest_' + Math.random().toString(36).substr(2, 7)));

    ws.id = socketId;

    let profileData = null;
    if (supabase && userId && !userId.startsWith('guest_')) {
        const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
        profileData = data;
        if (profileData && profileData.points_balance !== undefined) {
            userWallets[socketId] = Number(profileData.points_balance) || 0;
        }
    }

    if (userWallets[socketId] === undefined) {
        userWallets[socketId] = 0;
    }

    const isGuest = socketId.startsWith('guest_');
    let player = activePlayers[socketId] || standVault[socketId];

    // تحديد الدولة المختارة (الخيار القادم من الواجهة له الأولوية)
    const activeCountry = selectedCountry || profileData?.country_code || 'SY';

    if (!player) {
        const initialPwr = Number(profileData?.pwr) || 0;
        const initialSpawn = getRandomOnPitchPosition(calculateRadius(initialPwr));

        player = {
            id: socketId,
            name: profileData?.display_name || profileData?.username || (isGuest ? `زائر_${socketId.slice(-4)}` : 'لاعب'),
            points: initialPwr,
            tier: profileData?.tier || 'Bronze',
            country: getCountryInfo(activeCountry),
            x: initialSpawn.x,
            y: initialSpawn.y,
            targetX: initialSpawn.x,
            targetY: initialSpawn.y,
            radius: calculateRadius(initialPwr),
            isProtected: true,
            protectedUntil: Date.now() + 5000
        };
    } else {
        // تحديث دولة اللاعب بالقيمة الجديدة دائماً
        player.country = getCountryInfo(activeCountry);

        if (profileData && profileData.pwr !== undefined && profileData.pwr !== null && !isGuest) {
            player.points = Number(profileData.pwr) || 0;
        } else {
            player.points = player.points || 0;
        }
        player.radius = calculateRadius(player.points);

        if (typeof player.x !== 'number' || typeof player.y !== 'number') {
            const initialSpawn = getRandomOnPitchPosition(player.radius);
            player.x = initialSpawn.x;
            player.y = initialSpawn.y;
            player.targetX = initialSpawn.x;
            player.targetY = initialSpawn.y;
        }
    }

    // حفظ الدولة الجديدة في Supabase للمستخدمين المسجلين
    if (supabase && !isGuest && selectedCountry) {
        supabase
            .from('profiles')
            .update({ country_code: selectedCountry })
            .eq('id', socketId)
            .then(({ error }) => {
                if (error) console.error("خطأ تحديث الدولة في قاعدة البيانات:", error.message);
            });
    }

    delete standVault[socketId];
    player.inStand = false;
    player.isBot = false;
    
    activePlayers[socketId] = player;

    ws.send(JSON.stringify({ 
        type: 'INIT', 
        selfId: socketId,
        standLocations: STAND_LOCATIONS,
        pitchBounds: PITCH_BOUNDS,
        walletBalance: userWallets[socketId] || 0
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'TRANSFER_TO_WALLET') {
                const player = activePlayers[socketId];
                if (player && (player.points || 0) > 0) {
                    const requestedAmount = Math.max(1, parseInt(data.amount) || 1);
                    const actualTransfer = Math.min(player.points, requestedAmount);

                    player.points -= actualTransfer;
                    player.radius = calculateRadius(player.points);

                    userWallets[socketId] = (userWallets[socketId] || 0) + actualTransfer;
                    updateDatabaseBalanceSafely(socketId, userWallets[socketId], player.points);

                    ws.send(JSON.stringify({
                        type: 'WALLET_UPDATE',
                        walletBalance: userWallets[socketId]
                    }));
                }
            } else if (data.type === 'CHARGE_ORB') {
                const player = activePlayers[socketId];
                const amount = Math.max(1, parseInt(data.amount) || 1);
                const currentBalance = userWallets[socketId] || 0;

                if (player && currentBalance >= amount) {
                    userWallets[socketId] = currentBalance - amount;
                    player.points = (player.points || 0) + amount;
                    player.radius = calculateRadius(player.points);

                    updateDatabaseBalanceSafely(socketId, userWallets[socketId], player.points);

                    ws.send(JSON.stringify({
                        type: 'WALLET_UPDATE',
                        walletBalance: userWallets[socketId]
                    }));
                }
            } else if (data.type === 'REENTER_ARENA') {
                if (standVault[socketId] || activePlayers[socketId]) {
                    let p = standVault[socketId] || activePlayers[socketId];
                    delete standVault[socketId];

                    p.points = 0;
                    p.radius = calculateRadius(0);

                    const spawnPos = getRandomOnPitchPosition(60);
                    
                    p.inStand = false;
                    p.x = spawnPos.x;
                    p.y = spawnPos.y;
                    p.targetX = spawnPos.x;
                    p.targetY = spawnPos.y;
                    p.isProtected = true;
                    p.protectedUntil = Date.now() + 5000;
                    
                    activePlayers[socketId] = p;

                    updateDatabaseBalanceSafely(socketId, undefined, 0);
                }
            } else if (data.type === 'TARGET') {
                const current = activePlayers[socketId];
                if (current && typeof data.x === 'number' && typeof data.y === 'number') {
                    const r = current.radius || 60;
                    current.targetX = Math.max(PITCH_BOUNDS.minX + r, Math.min(PITCH_BOUNDS.maxX - r, data.x));
                    current.targetY = Math.max(PITCH_BOUNDS.minY + r, Math.min(PITCH_BOUNDS.maxY - r, data.y));
                }
            } else if (data.type === 'ADMIN_ACTION') {
                if (data.adminKey && data.adminKey !== ADMIN_SECRET) {
                    return;
                }

                if (data.action === 'SPAWN_BOT') {
                    const count = Math.min(20, Math.max(1, parseInt(data.count) || 1));
                    const pts = Math.max(1, parseInt(data.points) || 10);
                    for (let c = 0; c < count; c++) {
                        spawnBotFromPool(pts);
                    }
                } else if (data.action === 'CLEAR_BOTS') {
                    Object.keys(activePlayers).forEach(id => {
                        if (activePlayers[id].isBot) delete activePlayers[id];
                    });
                } else if (data.action === 'SET_GUEST_POINTS') {
                    const newPts = Math.max(1, parseInt(data.points) || 10);
                    Object.keys(activePlayers).forEach(id => {
                        if (isGuestPlayer(activePlayers[id]) && !activePlayers[id].isBot) {
                            activePlayers[id].points = newPts;
                            activePlayers[id].radius = calculateRadius(newPts);
                        }
                    });
                }
            }
        } catch (e) {
            console.error("خطأ معالجة الرسالة:", e);
        }
    });

    ws.on('close', () => {
        if (activePlayers[socketId]) {
            const disconnectedPlayer = activePlayers[socketId];
            delete activePlayers[socketId];

            disconnectedPlayer.inStand = true;
            standVault[socketId] = disconnectedPlayer;

            if (!isGuestPlayer(disconnectedPlayer) && !disconnectedPlayer.isBot) {
                updateDatabaseBalanceSafely(socketId, userWallets[socketId], disconnectedPlayer.points);
            }
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
                    executeEat(predator, victim);
                }
            }
        }
    }
}

function executeEat(predator, victim) {
    const delta = 1;

    predator.points = (predator.points || 0) + delta;
    predator.radius = calculateRadius(predator.points);

    victim.points = Math.max(0, (victim.points || 0) - delta);
    victim.radius = calculateRadius(victim.points);

    if (!isGuestPlayer(predator) && !predator.isBot) {
        updateDatabaseBalanceSafely(predator.id, undefined, predator.points);
    }

    if (!isGuestPlayer(victim) && !victim.isBot) {
        updateDatabaseBalanceSafely(victim.id, undefined, victim.points);
    }

    if (victim.points <= 0) {
        delete activePlayers[victim.id];
        
        if (!victim.isBot) {
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
                    const safeDistance = p.radius + other.radius + 1500;
                    if (dist < safeDistance && dist > 0) {
                        dangerFound = true;
                        const force = (safeDistance - dist) / safeDistance;
                        fleeX -= (dx / dist) * force;
                        fleeY -= (dy / dist) * force;
                    }
                } 
                else if ((p.points || 0) > (other.points || 0) && !other.isProtected) {
                    const huntDistance = 2500;
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

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'SYNC',
                activePlayers,
                standLocations: STAND_LOCATIONS,
                standTotals: getStandTotals(),
                walletBalance: userWallets[client.id] || 0,
                incentivePool: incentivePool,
                incentiveTarget: incentiveTarget
            }));
        }
    });
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));