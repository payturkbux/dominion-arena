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

// حدود الملعب والمدرجات
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

// دالة حساب نصف القطر بناءً على الرصيد
function calculateRadius(points) {
    const base = 35;
    const val = Math.max(0, Number(points) || 0);
    const dynamicSize = Math.log10(val + 1) * 15;
    return Math.min(120, Math.max(base, base + dynamicSize));
}

// دالة حساب السرعة الحركية (الكرة الأكبر أبطأ نسبياً)
function calculateSpeed(radius) {
    return Math.max(0.05, 0.25 - (radius / 500));
}

// جلب الجمهور الخامل إلى المدرجات من Supabase
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
            console.log(` تم تحميل ${Object.keys(standVault).length} لاعب خامل للمدرجات.`);
        }
    } catch (err) {
        console.error("خطأ جلب بيانات Supabase:", err);
    }
}

function getCountryFlag(code) {
    const flags = { "SY": "🇸🇾", "SA": "🇸🇦", "TR": "🇹🇷", "EG": "🇪🇬", "AE": "🇦🇪" };
    return flags[code] || "🚩";
}

loadOfflinePlayersToStands();

// كشف الاتصالات الميتة (Heartbeat)
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

    // تجهيز كائن اللاعب
    const balance = Number(profileData?.points_balance || 0);
    const country = profileData?.country_code || 'SY';
    const playerRadius = calculateRadius(balance);

    let player = standVault[socketId] || {
        id: socketId,
        name: profileData?.display_name || profileData?.username || (socketId.startsWith('guest_') ? `زائر_${socketId.slice(-4)}` : 'لاعب'),
        points: balance,
        tier: profileData?.tier || 'Bronze',
        country: { code: country, flag: getCountryFlag(country) },
        x: 3600,
        y: 3700,
        radius: playerRadius
    };

    // إزالة اللاعب من المدرج وإضافته للاعبين النشطين في الميدان
    delete standVault[socketId];
    player.inStand = false;
    player.targetX = player.x;
    player.targetY = player.y;

    activePlayers[socketId] = player;

    // إرسال معرف الجلسة المعتمد
    ws.send(JSON.stringify({ type: 'INIT', selfId: socketId }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'TARGET') {
                const current = activePlayers[socketId];
                if (current && typeof data.x === 'number' && typeof data.y === 'number') {
                    // تطبيق الحدود وتأمين البيانات المدخلة
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

            // إعادة اللاعب إلى المدرج
            disconnectedPlayer.inStand = true;
            const stand = STAND_LOCATIONS[disconnectedPlayer.country?.code] || STAND_LOCATIONS['SY'];
            disconnectedPlayer.x = stand.x + (Math.random() * 200 - 100);
            disconnectedPlayer.y = stand.y + (Math.random() * 100 - 50);
            standVault[socketId] = disconnectedPlayer;
        }
    });
});

// فحص وإغلاق الاتصالات الميتة كل 30 ثانية
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

// حلقة الفيزياء والبث الفعال السريع (30 FPS)
setInterval(() => {
    // 1. تحديث الفيزياء والمواقع محلياً على السيرفر
    Object.values(activePlayers).forEach(p => {
        if (typeof p.targetX === 'number' && typeof p.targetY === 'number') {
            const speed = calculateSpeed(p.radius);
            p.x += (p.targetX - p.x) * speed;
            p.y += (p.targetY - p.y) * speed;
        }
    });

    // 2. تجميع البيانات المحدثة فقط
    const payload = JSON.stringify({
        type: 'SYNC',
        activePlayers,
        standVault
    });

    // 3. البث المباشر لجميع المتصلين
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Authoritative Game Server running on port ${PORT}`));