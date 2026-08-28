const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// هيكلية تخزين البيانات الحية
let activePlayers = {}; // الكرات الموجودة حالياً داخل الميدان (العشب)
let standVault = {};    // جميع مستخدمي المنصة المتواجدين في المدرجات
let dynamicStands = {}; // مدرجات الدول المنشأة ديناميكياً

// حدود المستطيل الخاص بميدان الملعب (العشب)
const PITCH = { minX: 800, maxX: 7200, minY: 2200, maxY: 5800 };

// إحداثيات البداية للمدرجات (السطر العلوي فوق الملعب)
let nextStandX = 1200;

/**
 * دالة حساب نصف قطر (حجم) الكرة بناءً على نقاط المستخدم في محفظة Taralali
 * الحجم يعكس الرصيد مباشرة: الحد الأدنى 32px وتكبر المساحة جذرياً مع زيادة النقاط
 */
function calculateRadius(points) {
    const pts = Math.max(0, points || 0);
    return Math.max(32, Math.sqrt(pts) * 0.45);
}

/**
 * دالة جلب أو إنشاء مدرج دولة جديدة ديناميكياً
 */
function getOrCreateCountryStand(countryCode, countryName, flag) {
    const code = (countryCode || 'GLOBAL').toUpperCase();
    if (!dynamicStands[code]) {
        dynamicStands[code] = {
            code: code,
            name: countryName || code,
            flag: flag || '🌐',
            x: nextStandX,
            y: 1100,
            color: `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}` // لون نيون مميز للمدرج
        };
        nextStandX += 1400; // مسافة بين مدرج كل دولة والأخرى
    }
    return dynamicStands[code];
}

/**
 * دالة إعادة حساب وتوزيع مواقع مقاعد الكرات داخل مدرج الدولة
 * تتسع الصفوف والأعمدة تلقائياً بناءً على عدد وحجم كرات الأعضاء في المدرج
 */
function recalculateStandPositions(countryCode) {
    const code = (countryCode || 'GLOBAL').toUpperCase();
    const members = Object.values(standVault).filter(p => p.country.code === code);
    const stand = dynamicStands[code];
    if (!stand) return;

    // ترتيب الأعضاء حسب الرصيد (الأكبر نقاطاً يظهر في الصفوف الأولى)
    members.sort((a, b) => b.points - a.points);

    const cols = Math.max(3, Math.ceil(Math.sqrt(members.length)));
    members.forEach((p, idx) => {
        const row = Math.floor(idx / cols);
        const col = idx % cols;
        // حساب المسافات بناءً على إحداثيات مركز المدرج
        p.x = stand.x + (col - (cols - 1) / 2) * 190;
        p.y = stand.y + row * 160;
    });
}

/**
 * دالة شحن أو تحديث مستخدم من منصة Taralali إلى المدرج
 * (تستدعى عند الدخول أو عند جلب قاعدة البيانات)
 */
function syncTaralaliUserToStand(userData) {
    const { userId, name, countryCode, countryName, flag, points } = userData;
    const countryObj = getOrCreateCountryStand(countryCode, countryName, flag);

    // إذا لم يكن العضو يلعب حالياً في الميدان، نقوم بتحديث/إضافة كرته في المدرج
    if (!activePlayers[userId]) {
        const currentPoints = points !== undefined ? points : 10000;
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
// إدارة اتصالات الـ WebSocket
// ==========================================
wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.replace('/?', ''));
    
    // استخراج بيانات مستخدم Taralali من رابط الاتصال
    const userId = urlParams.get('userId') || 'user_' + Math.random().toString(36).substr(2, 6);
    const countryCode = (urlParams.get('country') || 'SY').toUpperCase();
    const countryName = urlParams.get('countryName') || countryCode;
    const flag = urlParams.get('flag') || '🇸🇾';
    const username = urlParams.get('name') || `لاعب_${userId.substr(0, 4)}`;
    const userPoints = parseInt(urlParams.get('points'), 10) || 25000;

    // توطين المستخدم في المدرج الخاص بدولته فور اتصاله
    syncTaralaliUserToStand({
        userId: userId,
        name: username,
        countryCode: countryCode,
        countryName: countryName,
        flag: flag,
        points: userPoints
    });

    // إرسال معرف الجلسة الخاص بالعميل
    ws.send(JSON.stringify({ type: 'INIT', selfId: userId }));

    // استقبال الأوامر من العميل
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // ⚔️ 1. أمر النزول من المدرج إلى الميدان للمنافسة
            if (data.type === 'ENTER_ARENA' && standVault[userId]) {
                const player = standVault[userId];
                player.inStand = false;
                
                // إنزال الكرة في مكان عشوائي داخل حدود العشب
                player.x = PITCH.minX + 200 + Math.random() * (PITCH.maxX - PITCH.minX - 400);
                player.y = PITCH.minY + 200 + Math.random() * (PITCH.maxY - PITCH.minY - 400);
                player.vx = 0;
                player.vy = 0;

                // نقل الكرة من المدرج إلى قائمة اللاعبين النشطين في الميدان
                activePlayers[userId] = player;
                delete standVault[userId];
                
                recalculateStandPositions(player.country.code);
            }

            // 🎯 2. أمر توجيه الكرة داخل الميدان عبر الماوس / اللمس
            if (data.type === 'TARGET' && activePlayers[userId]) {
                const player = activePlayers[userId];
                const dx = data.x - player.x;
                const dy = data.y - player.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist > 15) {
                    // السرعة تتناسب عكسياً مع حجم الكرة (الكرات الضخمة أثقل قليلاً)
                    const speed = Math.max(3, 9 - (player.radius * 0.03));
                    player.vx = (dx / dist) * speed;
                    player.vy = (dy / dist) * speed;
                } else {
                    player.vx = 0;
                    player.vy = 0;
                }
            }

            // 🔄 3. تحديث نقاط المحفظة من المنصة الخارجية (API Sync)
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
                }
            }
        } catch (err) {
            console.error('Error processing message:', err);
        }
    });

    // عند قطع الاتصال
    ws.on('close', () => {
        // ملاحظة: تظل الكرة مسجلة في المدرج إذا أردنا إبقاء عرض جميع أعضاء المنصة،
        // ولكن هنا نحذف الجلسة الحية لتنظيف الذكرة عند المغادرة التامة.
        if (activePlayers[userId]) {
            const countryCode = activePlayers[userId].country.code;
            delete activePlayers[userId];
            recalculateStandPositions(countryCode);
        }
    });
});

// ==========================================
// حلقة الفيزياء والحسابات اللحظية (40ms = 25 FPS)
// ==========================================
setInterval(() => {
    const activeList = Object.values(activePlayers);

    // 1. تحديث إحداثيات الكرات على العشب وتطبيق حواجز الملعب
    activeList.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        // الاحتكاك البسيط لإبطاء الحركة تدريجياً
        p.vx *= 0.98;
        p.vy *= 0.98;

        // حماية الخروج خارج خطوط الملعب
        if (p.x - p.radius < PITCH.minX) { p.x = PITCH.minX + p.radius; p.vx = 0; }
        if (p.x + p.radius > PITCH.maxX) { p.x = PITCH.maxX - p.radius; p.vx = 0; }
        if (p.y - p.radius < PITCH.minY) { p.y = PITCH.minY + p.radius; p.vy = 0; }
        if (p.y + p.radius > PITCH.maxY) { p.y = PITCH.maxY - p.radius; p.vy = 0; }
    });

    // 2. منطق التصادم والابتلاع والخصم والعودة للمدرج
    for (let i = 0; i < activeList.length; i++) {
        for (let j = i + 1; j < activeList.length; j++) {
            const a = activeList[i];
            const b = activeList[j];

            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // تحقق من التداخل بين الكرتين
            if (dist < Math.abs(a.radius - b.radius) + 5) {
                const bigger = a.radius > b.radius ? a : b;
                const smaller = a.radius > b.radius ? b : a;

                // يشترط أن تكون الكرة الأكبر حجمها أكبر بـ 8% على الأقل لابتلاع الأصغر
                if (bigger.radius > smaller.radius * 1.08) {
                    
                    // خصم نقطة من المهزوم وإضافتها للفائز
                    smaller.points = Math.max(0, smaller.points - 1);
                    bigger.points += 1;

                    // تحديث حجم الكرتين مباشرة بناءً على النقاط الجديدة
                    smaller.radius = calculateRadius(smaller.points);
                    bigger.radius = calculateRadius(bigger.points);

                    // طرد المهزوم من الميدان وإعادته فوراً لـ (مدرج بلده)
                    smaller.inStand = true;
                    smaller.vx = 0;
                    smaller.vy = 0;

                    standVault[smaller.id] = smaller;
                    delete activePlayers[smaller.id];

                    // إعادة تنظيم مقاعد المدرج للدولة بعد عودة المهزوم
                    recalculateStandPositions(smaller.country.code);
                }
            }
        }
    }

    // 3. بث التحديث اللحظي الموحد لجميع المتصفحات الموصلة
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

// تشغيل الخادم
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`[Taralali Server] Arena server live on port ${PORT}`);
});