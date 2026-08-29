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

// 🏛️ أبعاد الساحة الكبرى الفعلية
const PITCH_BOUNDS = { minX: 0, maxX: 14000, minY: 0, maxY: 8000 };

let incentivePool = 100; // قيمة ابتدائية لصندوق التحفيز

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

// 🐌 ضبط سرعة البوتات لتكون ثابته وانسيابية
function getBotMoveSpeed(radius) {
    return Math.max(4, 12 - (radius / 100));
}

function getPlayerSpeedFactor(radius) {
    return Math.max(0.008, 0.025 - (radius / 8000));
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
    return !player || player.id.startsWith('guest_');
}

function getRandomOffPitchPosition(countryCode) {
    const stand = STAND_LOCATIONS[countryCode] || STAND_LOCATIONS['SY'];
    const halfW = (stand.width || 2000) / 2;
    const halfH = (stand.height || 400) / 2;

    return {
        x: stand.x + (Math.random() * (halfW * 1.6) - halfW * 0.8),
        y: stand.y + (Math.random() * (halfH * 1.6) - halfH * 0.8)
    };
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

// 📊 دالة حساب مجموع أرصدة اللاعبين والمدرجات التابعة لكل دولة
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

// 🤖 إنشاء البوتات الابتدائية
function spawnBot(botId, initialPoints = 5) {
    const randomName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    const randomCountry = COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
    
    const radius = calculateRadius(initialPoints);
    const pos = getRandomOnPitchPosition(radius);

    activePlayers[botId] = {
        id: botId,
        isBot: true,
        name: randomName,
        points: initialPoints,
        eatenPool: 0,
        tier: 'Gold',
        country: getCountryInfo(randomCountry),
        x: pos.x,
        y: pos.y,
        angle: Math.random() * Math.PI * 2,
        changeTimer: Math.floor(Math.random() * 60) + 30,
        radius: radius
    };
}

for (let i = 1; i <= 15; i++) {
    spawnBot(`bot_${i}`, 5);
}

// 📈 ربط نقاط وحجم البوتات بصندوق التحفيز بتدرج متناسب
function adjustBotsToIncentivePool() {
    const bots = Object.values(activePlayers).filter(p => p.isBot);
    if (bots.length === 0) return;

    let targetTotal = Math.max(15, incentivePool); // ضمان حد أدنى لنقاط البوتات
    const numBots = bots.length;

    // مصفوفة أوزان متدرجة (البوت الأول يكون كبيراً والبقية تتدرج تنازلياً)
    let weights = [];
    let weightSum = 0;
    for (let i = 0; i < numBots; i++) {
        let w = Math.pow(0.75, i); 
        weights.push(w);
        weightSum += w;
    }

    bots.forEach((bot, idx) => {
        let allocatedPoints = Math.max(1, Math.floor((weights[idx] / weightSum) * targetTotal));
        bot.points = allocatedPoints;
        bot.radius = calculateRadius(allocatedPoints);
    });
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

    // 🎯 الزائر يبدأ بـ 10 نقاط والمستخدم المسجل بحسب رصيده
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
    player.targetX = player.x;
    player.targetY = player.y;

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

                    if (isGuestPlayer(p)) p.points = 10; // إعادة تعيين نقاط الزائر لـ 10 عند العودة
                    p.radius = calculateRadius(p.points);

                    const spawnPos = getRandomOnPitchPosition(p.radius || 60);
                    
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
            const pos = getRandomOffPitchPosition(disconnectedPlayer.country?.code);
            disconnectedPlayer.x = pos.x;
            disconnectedPlayer.y = pos.y;
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

// ⚔️ فحص التصادمات بناءً على الحجم والواقعية
function checkCollisions() {
    const players = Object.values(activePlayers);
    const count = players.length;
    
    for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
            const p1 = players[i];
            const p2 = players[j];

            if (!p1 || !p2) continue;

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const distance = Math.hypot(dx, dy) || 1;

            const maxRadius = Math.max(p1.radius, p2.radius);
            
            // تحقق الابتلاع عند التداخل القريب
            if (distance < maxRadius * 0.75) {
                // 🌟 جعل الابتلاع معتمداً كلياً على الحجم لجميع الكرات
                if (p1.radius > p2.radius * 1.05) {
                    executeEat(p1, p2);
                } 
                else if (p2.radius > p1.radius * 1.05) {
                    executeEat(p2, p1);
                }
            }
        }
    }
}

function executeEat(predator, victim) {
    const stolenPoints = Math.max(1, Math.floor(victim.points * 0.5) || 1);

    if (predator.isBot) {
        predator.eatenPool = (predator.eatenPool || 0) + 1;
        predator.points += stolenPoints;
        predator.radius = calculateRadius(predator.points);
    } else if (isGuestPlayer(predator)) {
        // نمو الزائر وتحديث صندوق التحفيز
        predator.points = (predator.points || 0) + stolenPoints;
        predator.radius = calculateRadius(predator.points);

        incentivePool += stolenPoints;

        let realUsers = Object.values(activePlayers).filter(p => !isGuestPlayer(p) && !p.isBot && p.id !== victim.id);
        realUsers.sort((a, b) => a.points - b.points);

        if (realUsers.length > 0 && incentivePool > 0) {
            const distributeAmount = Math.floor(incentivePool * 0.5);
            if (distributeAmount > 0) {
                const targetsCount = Math.min(3, realUsers.length);
                const share = Math.floor(distributeAmount / targetsCount) || 1;

                for (let i = 0; i < targetsCount; i++) {
                    const target = realUsers[i];
                    target.points += share;
                    target.radius = calculateRadius(target.points);
                    updatePointsSafely(target.id, share);
                }
                incentivePool -= distributeAmount;
            }
        }
    } else {
        predator.points += stolenPoints;
        predator.radius = calculateRadius(predator.points);
        updatePointsSafely(predator.id, stolenPoints);
    }

    if (victim.isBot) {
        const botId = victim.id;
        delete activePlayers[botId];
        setTimeout(() => spawnBot(botId, 5), 3000); 
    } else {
        victim.points = Math.max(0, victim.points - stolenPoints);
        victim.radius = calculateRadius(victim.points);

        updatePointsSafely(victim.id, -stolenPoints);

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

// 🎯 حلقة التحديث الرئيسية (30 FPS)
setInterval(() => {
    // تحديث أوزان وأحجام البوتات بالنسبة لصندوق التحفيز
    adjustBotsToIncentivePool();

    Object.values(activePlayers).forEach(p => {
        const r = p.radius || 60;

        if (p.isBot) {
            // 🤖 حركة البوتات الانسيابية
            p.changeTimer--;
            if (p.changeTimer <= 0) {
                p.angle += (Math.random() - 0.5) * 0.8; 
                p.changeTimer = Math.floor(Math.random() * 40) + 20;
            }

            const botSpeed = getBotMoveSpeed(r);
            p.x += Math.cos(p.angle) * botSpeed;
            p.y += Math.sin(p.angle) * botSpeed;

            // 🛡️ انحراف عند الوصول للحدود
            if (p.x <= PITCH_BOUNDS.minX + r) {
                p.x = PITCH_BOUNDS.minX + r;
                p.angle = Math.PI - p.angle;
            } else if (p.x >= PITCH_BOUNDS.maxX - r) {
                p.x = PITCH_BOUNDS.maxX - r;
                p.angle = Math.PI - p.angle;
            }

            if (p.y <= PITCH_BOUNDS.minY + r) {
                p.y = PITCH_BOUNDS.minY + r;
                p.angle = -p.angle;
            } else if (p.y >= PITCH_BOUNDS.maxY - r) {
                p.y = PITCH_BOUNDS.maxY - r;
                p.angle = -p.angle;
            }

            p.targetX = p.x;
            p.targetY = p.y;
        } else {
            // 🕹️ حركة اللاعب الحقيقي
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
        standVault,
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
server.listen(PORT, () => console.log(`🚀 Agario Mobile-Optimized Server running on port ${PORT}`));