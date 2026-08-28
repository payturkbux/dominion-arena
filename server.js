const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// 🔗 إعدادات الاتصال بـ Supabase
// ==========================================
// استبدل القيم بالروابط الخاصة بمشروعك على Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bwbgfdteocewitdzrysg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ3YmdmZHRlb2Nld2l0ZHpyeXNnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NTE2MTMsImV4cCI6MjEwMzQyNzYxM30.C7hId5uF-p_7ibGSs0P7a2yxpOD-Zu4ON-lu7Pivn6k'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// هيكلية تخزين البيانات الحية
let activePlayers = {}; // الكرات الموجودة حالياً داخل الميدان (العشب)
let standVault = {};    // جميع مستخدمي المنصة المتواجدين في المدرجات
let dynamicStands = {}; // مدرجات الدول المنشأة ديناميكياً المحيطة بالملعب

// حدود مستطيل ميدان الملعب (العشب)
const PITCH = { minX: 1800, maxX: 6200, minY: 1800, maxY: 6200 };

/**
 * دالة حفظ بيانات اللاعب في Supabase عند التغير أو الخروج
 */
async function savePlayerToSupabase(player) {
    if (!player || !player.id) return;
    try {
        const { error } = await supabase
            .from('taralali_players')
            .update({
                points: player.points,
                in_stand: player.inStand
            })
            .eq('user_id', player.id);

        if (error) {
            console.error(`[Supabase Error] فشل حفظ بيانات اللاعب ${player.id}:`, error.message);
        }
    } catch (err) {
        console.error('[Supabase Exception]:', err);
    }
}

/**
 * دالة حساب نصف قطر (حجم) الكرة بناءً على نقاط المستخدم في محفظة Taralali
 */
function calculateRadius(points) {
    const pts = Math.max(0, points || 0);
    return Math.max(32, Math.sqrt(pts) * 0.45);
}

/**
 * دالة جلب أو إنشاء مدرج دولة جديدة ديناميكياً محيطاً بالملعب
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
 * دالة إعادة حساب وتوزيع مواقع مقاعد الكرات داخل مدرج الدولة
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
 * دالة مزامنة مستخدم منصة Taralali وتوطينه في مدرج بلده
 */
function syncTaralaliUserToStand(userData) {
    const { userId, name, countryCode, countryName, flag, countryImage, points } = userData;
    const countryObj = getOrCreateCountryStand(countryCode, countryName, flag, countryImage);

    if (!activePlayers[userId]) {
        const currentPoints = points !== undefined ? points : 1000;
        standVault[userId] = {
            id: userId,
            name: name || `عضو_${userId.toString().substr(0, 4)}`,
            country: countryObj,
            points: currentPoints,
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
// إدارة اتصالات الـ WebSocket مع Supabase
// ==========================================
wss.on('connection', async (ws, req) => {
    const urlParams = new URLSearchParams(req.url.replace('/?', ''));
    const userId = urlParams.get('userId');

    if (!userId) {
        ws.close();
        return;
    }

    // 📥 1. جلب بيانات المستخدم الحقيقية من Supabase
    let dbUser = null;
    try {
        const { data, error } = await supabase
            .from('taralali_players')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (!error && data) {
            dbUser = data;
        }
    } catch (e) {
        console.error('[Supabase Fetch Error]:', e);
    }

    // الاعتماد على بيانات Supabase إن وجدت، أو القيم الممررة من URL كخيار احتياطي
    const countryCode = (dbUser?.country_code || urlParams.get('country') || 'SY').toUpperCase();
    const countryName = urlParams.get('countryName') || countryCode;
    const flag = urlParams.get('flag') || '🇸🇾';
    const countryImage = urlParams.get('countryImage') || null;
    const username = dbUser?.username || urlParams.get('name') || `لاعب_${userId.substr(0, 4)}`;
    const userPoints = dbUser?.points !== undefined ? dbUser.points : (parseInt(urlParams.get('points'), 10) || 1000);

    syncTaralaliUserToStand({
        userId: userId,
        name: username,
        countryCode: countryCode,
        countryName: countryName,
        flag: flag,
        countryImage: countryImage,
        points: userPoints
    });

    ws.send(JSON.stringify({ type: 'INIT', selfId: userId }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // ⚔️ 1. أمر النزول للميدان
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
                savePlayerToSupabase(player); // حفظ الحالة (خارج المدرج)
            }

            // 🎯 2. توجيه الحركة
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

            // 🔄 3. تحديث نقاط المحفظة يدوياً
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
                    savePlayerToSupabase(targetOrb); // حفظ النقاط في Supabase
                }
            }
        } catch (err) {
            console.error('Error processing message:', err);
        }
    });

    // 📤 4. عند إغلاق الاتصال: حفظ البيانات الأخيرة في Supabase
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
// حلقة الفيزياء والابتلاع والخصم اللحظية
// ==========================================
setInterval(() => {
    const activeList = Object.values(activePlayers);

    // تحديث الإحداثيات
    activeList.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        p.vx *= 0.98;
        p.vy *= 0.98;

        if (p.x - p.radius < PITCH.minX) { p.x = PITCH.minX + p.radius; p.vx = 0; }
        if (p.x + p.radius > PITCH.maxX) { p.x = PITCH.maxX - p.radius; p.vx = 0; }
        if (p.y - p.radius < PITCH.minY) { p.y = PITCH.minY + p.radius; p.vy = 0; }
        if (p.y + p.radius > PITCH.maxY) { p.y = PITCH.maxY - p.radius; p.vy = 0; }
    });

    // منطق الابتلاع والخصم
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

                    // طرد المهزوم للمدرج
                    smaller.inStand = true;
                    smaller.vx = 0;
                    smaller.vy = 0;

                    standVault[smaller.id] = smaller;
                    delete activePlayers[smaller.id];

                    recalculateStandPositions(smaller.country.code);

                    // 💾 حفظ النقاط المحدثة في Supabase للاعبين
                    savePlayerToSupabase(smaller);
                    savePlayerToSupabase(bigger);
                }
            }
        }
    }

    // بث التحديث الموحد للجميع
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
    console.log(`[Taralali Server] Connected to Supabase on port ${PORT}`);
});