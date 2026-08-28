require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// 🔗 إعدادات الاتصال بـ Supabase
// ==========================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('[Supabase] 🟢 تم الربط بنجاح مع قاعدة البيانات.');
} else {
    console.error('[Supabase Error] ❌ لم يتم العثور على المفاتيح في بيئة التشغيل!');
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// هيكلية تخزين البيانات الحية في الذاكرة
let activePlayers = {}; // الكرات الموجودة حالياً داخل ميدان الملعب
let standVault = {};    // جميع مستخدمي المنصة (الموجودون في المدرجات)
let dynamicStands = {}; // مدرجات الدول المنشأة ديناميكياً

// حدود مستطيل ميدان الملعب (العشب)
const PITCH = { minX: 1800, maxX: 6200, minY: 1800, maxY: 6200 };

/**
 * 💾 دالة حفظ نقاط اللاعب في جدول profiles بـ Supabase
 */
async function savePlayerToSupabase(player) {
    if (!player || !player.id || player.isGuest || !supabase) return;
    try {
        const { error } = await supabase
            .from('profiles')
            .update({ points_balance: player.points })
            .eq('id', player.id);

        if (error) {
            console.error(`[Supabase Error] فشل حفظ نقاط ${player.id}:`, error.message);
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
 * دالة إعادة حساب وتنسيق مواقع الكرات داخل مدرج كل دولة
 */
function recalculateStandPositions(countryCode) {
    const code = (countryCode || 'GLOBAL').toUpperCase();
    const members = Object.values(standVault).filter(p => p.country && p.country.code === code);
    const stand = dynamicStands[code];
    if (!stand) return;

    // ترتيب اللاعبين داخل مدرج الدولة حسب نقاطهم (الأعلى نقاطاً في المقاعد الأمامية)
    members.sort((a, b) => b.points - a.points);
    const cols = Math.max(4, Math.ceil(Math.sqrt(members.length)));

    members.forEach((p, idx) => {
        const row = Math.floor(idx / cols);
        const col = idx % cols;

        if (stand.side === 0 || stand.side === 2) {
            p.x = stand.x + (col - (cols - 1) / 2) * 160;
            p.y = stand.y + (stand.side === 0 ? -row * 140 : row * 140);
        } else {
            p.x = stand.x + (stand.side === 1 ? row * 140 : -row * 140);
            p.y = stand.y + (col - (cols - 1) / 2) * 160;
        }
    });
}

/**
 * 🏛️ جلب كافة الحسابات المسجلة بـ Supabase (حتى 1000 حساب) وتسكين كراتهم بالمدرجات
 */
async function fetchAndPopulateAllStands() {
    if (!supabase) return;
    try {
        // سحب كافة المستخدمين المسجلين في النظام بدون تقييد العدد
        const { data: users, error } = await supabase
            .from('profiles')
            .select('id, display_name, username, points_balance, tier, country_code, country_name, country_flag')
            .order('points_balance', { ascending: false })
            .limit(1000);

        if (error) {
            console.error('[Supabase Fetch Error]:', error.message);
            return;
        }

        if (users && users.length > 0) {
            users.forEach(u => {
                // إذا لم يكن اللاعب متواجد حالياً في وسط الميدان، يتم تسكينه أو تحديث مدرجه
                if (!activePlayers[u.id]) {
                    const cCode = (u.country_code || 'SY').toUpperCase();
                    const countryObj = getOrCreateCountryStand(cCode, u.country_name || cCode, u.country_flag || '🇸🇾', null);
                    const pts = Number(u.points_balance || 1000);

                    standVault[u.id] = {
                        id: u.id,
                        name: u.display_name || u.username || `لاعب_${u.id.substring(0, 4)}`,
                        country: countryObj,
                        points: pts,
                        tier: u.tier || 'Bronze',
                        inStand: true,
                        x: countryObj.x,
                        y: countryObj.y,
                        vx: 0,
                        vy: 0,
                        radius: calculateRadius(pts)
                    };
                    recalculateStandPositions(cCode);
                }
            });
            console.log(`[Taralali Engine] 🏟️ تم عرض جميع كرات المنصة (${users.length} حساب مسجل) على مدرجات الدول.`);
        }
    } catch (e) {
        console.error('[Supabase Exception]:', e);
    }
}

// تحميل كافة الكرات إلى المدرجات فور تشغيل السيرفر
fetchAndPopulateAllStands();
// إعادة جلب ومزامنة أي لاعبين جدد يسجلون بالمنصة كل 60 ثانية
setInterval(fetchAndPopulateAllStands, 60000);

// ==========================================
// إدارة اتصالات الزوار واللاعبين الحية
// ==========================================
wss.on('connection', async (ws, req) => {
    const urlParams = new URLSearchParams(req.url.replace('/?', '').replace('/', ''));
    let userId = urlParams.get('userId');
    const isGuest = !userId;

    if (isGuest) {
        userId = `guest_${Math.random().toString(36).substring(2, 9)}`;
    }

    // إرسال كشوفات مدرجات جميع لاعبي المنصة للعميل أو الزائر فور الاتصال
    ws.send(JSON.stringify({ 
        type: 'INIT', 
        selfId: userId,
        isGuest: isGuest 
    }));

    ws.on('message', (message) => {
        if (isGuest) return; // الزائر يتصفح فقط

        try {
            const data = JSON.parse(message);

            // ⚔️ نزول كرة من مدرجها إلى الساحة
            if (data.type === 'ENTER_ARENA' && standVault[userId]) {
                const player = standVault[userId];
                player.inStand = false;
                player.x = PITCH.minX + 200 + Math.random() * (PITCH.maxX - PITCH.minX - 400);
                player.y = PITCH.minY + 200 + Math.random() * (PITCH.maxY - PITCH.minY - 400);
                
                activePlayers[userId] = player;
                delete standVault[userId];
                recalculateStandPositions(player.country.code);
            }

            // 🎯 توجيه الكرة داخل الميدان
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

            // 🔄 تحديث النقاط وحفظها بـ Supabase
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

    ws.on('close', async () => {
        if (!isGuest && activePlayers[userId]) {
            // عند خروج اللاعب من اللعبة، تعود كرته إلى مكانها في مدرج دولته
            const player = activePlayers[userId];
            player.inStand = true;
            player.vx = 0;
            player.vy = 0;
            standVault[userId] = player;
            delete activePlayers[userId];
            recalculateStandPositions(player.country.code);
            await savePlayerToSupabase(player);
        }
    });
});

// ==========================================
// حلقة الفيزياء والبث الحقيقي لجميع المتصلين
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
        if (p.y + p.radius > PITCH.maxY) { p.y = PITCH.maxY - p.radius; p.vy = 0; }
    });

    // تصادم الكرات وحساب النقاط
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

    // بث الكشوفات الكاملة (المدرجات + الساحة) لكل زائر ولاعب متصل
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
    console.log(`[Taralali Server] 🚀 يعمل بنجاح على المنفذ ${PORT}`);
});