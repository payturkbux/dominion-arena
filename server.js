require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// 🔗 إعدادات الاتصال بـ Supabase (تعتمد على Render Environment Variables)
// ==========================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[Supabase Critical Error] لم يتم العثور على SUPABASE_URL أو SUPABASE_KEY في بيئة التشغيل!');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// هيكلية تخزين البيانات الحية
let activePlayers = {}; // الكرات الموجودة حالياً داخل الميدان
let standVault = {};    // مستخدمي المنصة المتواجدين في المدرجات
let dynamicStands = {}; // مدرجات الدول المنشأة ديناميكياً

// حدود مستطيل ميدان الملعب (العشب)
const PITCH = { minX: 1800, maxX: 6200, minY: 1800, maxY: 6200 };

/**
 * 💾 دالة حفظ نقاط اللاعب في جدول profiles بـ Supabase
 */
async function savePlayerToSupabase(player) {
    if (!player || !player.id) return;
    try {
        const { error } = await supabase
            .from('profiles')
            .update({
                points_balance: player.points
            })
            .eq('id', player.id);

        if (error) {
            console.error(`[Supabase Error] فشل تحديث نقاط اللاعب ${player.id}:`, error.message);
        }
    } catch (err) {
        console.error('[Supabase Exception]:', err);
    }
}

/**
 * دالة حساب حجم الكرة بناءً على النقاط
 */
function calculateRadius(points) {
    const pts = Math.max(0, points || 0);
    return Math.max(32, Math.sqrt(pts) * 0.45);
}

/**
 * دالة إنشاء أو جلب مدرج الدولة
 */
function getOrCreateCountryStand(countryCode, countryName, flag, countryImage) {
    const code = (countryCode || 'GLOBAL').toUpperCase();
    if (!dynamicStands[code]) {
        const standIndex = Object.keys(dynamicStands).length;
        
        const side = standIndex % 4;
        const indexOnSide = Math.floor(standIndex / 4);

        let baseX = 0, baseY = 0;
        const spacing = 1200;

        if (side === 0) {
            baseX = PITCH.minX + 600 + (indexOnSide * spacing);
            baseY = PITCH.minY - 700;
        } else if (side === 1) {
            baseX = PITCH.maxX + 700;
            baseY = PITCH.minY + 600 + (indexOnSide * spacing);
        } else if (side === 2) {
            baseX = PITCH.minX + 600 + (indexOnSide * spacing);
            baseY = PITCH.maxY + 700;
        } else {
            baseX = PITCH.minX - 700;
            baseY = PITCH.minY + 600 + (indexOnSide * spacing);
        }

        dynamicStands[code] = {
            code: code,
            name: countryName || code,
            flag: flag || '🌐',
            countryImage: countryImage || null,
            side: side,
            x: baseX,
            y: baseY,
            color: `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`
        };
    }
    return dynamicStands[code];
}

/**
 * دالة توزيع الكرات داخل مدرج الدولة
 */
function recalculateStandPositions(countryCode) {
    const code = (countryCode || 'GLOBAL').toUpperCase();
    const members = Object.values(standVault).filter(p => p.country.code === code);
    const stand = dynamicStands[code];
    if (!stand) return;

    members.sort((a, b) => b.points - a.points);

    const cols = Math.max(3, Math.ceil(Math.sqrt(members.length)));
    members.forEach((p, idx) => {
        const row = Math.floor(idx / cols);
        const col = idx % cols;

        if (stand.side === 0 || stand.side === 2) {
            p.x = stand.x + (col - (cols - 1) / 2) * 180;
            p.y = stand.y + (stand.side === 0 ? -row * 150 : row * 150);
        } else {
            p.x = stand.x + (stand.side === 1 ? row * 150 : -row * 150);
            p.y = stand.y + (col - (cols - 1) / 2) * 180;
        }
    });
}

/**
 * مزامنة اللاعب وتواجد في مدرجه مع بياناته والرتبة
 */
function syncTaralaliUserToStand(userData) {
    const { userId, name, countryCode, countryName, flag, countryImage, points, tier } = userData;
    const countryObj = getOrCreateCountryStand(countryCode, countryName, flag, countryImage);

    if (!activePlayers[userId]) {
        const currentPoints = points !== undefined ? points : 1000;
        standVault[userId] = {
            id: userId,
            name: name || `عضو_${userId.toString().substr(0, 4)}`,
            country: countryObj,
            points: currentPoints,
            tier: tier || 'Bronze', // 🏅 حفظ رتبة اللاعب (Silver / Bronze / Gold...)
            inStand: true,
            x: countryObj.x,
            y: countryObj.y,
            vx: 0,
            vy: 0,
            radius: calculateRadius(currentPoints)
        };
        recalculateStandPositions(countryObj.code);
    }
}

// ==========================================
// إدارة الاتصالات الحية مع Supabase
// ==========================================
wss.on('connection', async (ws, req) => {
    const urlParams = new URLSearchParams(req.url.replace('/?', ''));
    const userId = urlParams.get('userId');

    if (!userId) {
        ws.close();
        return;
    }

    // 📥 1. جلب بيانات اللاعب والحقول الحقيقية (display_name, points_balance, tier) من profiles
    let dbUser = null;
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        if (!error && data) {
            dbUser = data;
        } else if (error) {
            console.error(`[Supabase Fetch Error for ${userId}]:`, error.message);
        }
    } catch (e) {
        console.error('[Supabase Exception]:', e);
    }

    const countryCode = (urlParams.get('country') || 'SY').toUpperCase();
    const countryName = urlParams.get('countryName') || countryCode;
    const flag = urlParams.get('flag') || '🇸🇾';
    const countryImage = urlParams.get('countryImage') || null;
    
    // ربط الحقول مع الأعمدة الحقيقية من Supabase
    const username = dbUser?.display_name || dbUser?.username || urlParams.get('name') || `لاعب_${userId.substr(0, 4)}`;
    const userPoints = dbUser?.points_balance !== undefined ? dbUser.points_balance : (parseInt(urlParams.get('points'), 10) || 1000);
    const userTier = dbUser?.tier || 'Bronze'; // قراءة عمود tier

    syncTaralaliUserToStand({
        userId: userId,
        name: username,
        countryCode: countryCode,
        countryName: countryName,
        flag: flag,
        countryImage: countryImage,
        points: userPoints,
        tier: userTier
    });

    ws.send(JSON.stringify({ type: 'INIT', selfId: userId }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // ⚔️ أمر النزول للميدان
            if (data.type === 'ENTER_ARENA' && standVault[userId]) {
                const player = standVault[userId];
                player.inStand = false;
                
                player.x = PITCH.minX + 200 + Math.random() * (PITCH.maxX - PITCH.minX - 400);
                player.y = PITCH.minY + 200 + Math.random() * (PITCH.maxY - PITCH.minY - 400);
                player.vx = 0;
                player.vy = 0;

                activePlayers[userId] = player;
                delete standVault[userId];
                
                recalculateStandPositions(player.country.code);
            }

            // 🎯 توجيه الحركة
            if (data.type === 'TARGET' && activePlayers[userId]) {
                const player = activePlayers[userId];
                const dx = data.x - player.x;
                const dy = data.y - player.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist > 15) {
                    const speed = Math.max(3, 9 - (player.radius * 0.03));
                    player.vx = (dx / dist) * speed;
                    player.vy = (dy / dist) * speed;
                } else {
                    player.vx = 0;
                    player.vy = 0;
                }
            }

            // 🔄 تحديث النقاط من الواجهة وحفظها في Supabase
            if (data.type === 'UPDATE_WALLET_POINTS') {
                const targetId = data.targetUserId || userId;
                const newPoints = data.newPoints;
                
                const targetOrb = activePlayers[targetId] || standVault[targetId];
                if (targetOrb) {
                    targetOrb.points = newPoints;
                    targetOrb.radius = calculateRadius(newPoints);
                    if (targetOrb.inStand) {
                        recalculateStandPositions(targetOrb.country.code);
                    }
                    savePlayerToSupabase(targetOrb);
                }
            }
        } catch (err) {
            console.error('Error processing message:', err);
        }
    });

    // 📤 حفظ النقاط فور إغلاق الجلسة
    ws.on('close', async () => {
        const player = activePlayers[userId] || standVault[userId];
        if (player) {
            await savePlayerToSupabase(player);
            
            const countryCode = player.country.code;
            delete activePlayers[userId];
            delete standVault[userId];
            recalculateStandPositions(countryCode);
        }
    });
});

// ==========================================
// حلقة الفيزياء والالتهام الحية
// ==========================================
setInterval(() => {
    const activeList = Object.values(activePlayers);

    activeList.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        p.vx *= 0.98;
        p.vy *= 0.98;

        if (p.x - p.radius < PITCH.minX) { p.x = PITCH.minX + p.radius; p.vx = 0; }
        if (p.x + p.radius > PITCH.maxX) { p.x = PITCH.maxX - p.radius; p.vx = 0; }
        if (p.y - p.radius < PITCH.minY) { p.y = PITCH.minY + p.radius; p.vx = 0; }
        if (p.y + p.radius > PITCH.maxY) { p.y = PITCH.maxY - p.radius; p.vx = 0; }
    });

    for (let i = 0; i < activeList.length; i++) {
        for (let j = i + 1; j < activeList.length; j++) {
            const a = activeList[i];
            const b = activeList[j];

            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < Math.abs(a.radius - b.radius) + 5) {
                const bigger = a.radius > b.radius ? a : b;
                const smaller = a.radius > b.radius ? b : a;

                if (bigger.radius > smaller.radius * 1.08) {
                    smaller.points = Math.max(0, smaller.points - 1);
                    bigger.points += 1;

                    smaller.radius = calculateRadius(smaller.points);
                    bigger.radius = calculateRadius(bigger.points);

                    smaller.inStand = true;
                    smaller.vx = 0;
                    smaller.vy = 0;

                    standVault[smaller.id] = smaller;
                    delete activePlayers[smaller.id];

                    recalculateStandPositions(smaller.country.code);

                    savePlayerToSupabase(smaller);
                    savePlayerToSupabase(bigger);
                }
            }
        }
    }

    const payload = JSON.stringify({
        type: 'SYNC',
        activePlayers: activePlayers,
        standVault: standVault,
        dynamicStands: dynamicStands
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 40);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`[Taralali Server] Running and connected to profiles on port ${PORT}`);
});