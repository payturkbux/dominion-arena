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
let dynamicStands = {}; // مدرجات الدول المنشأة ديناميكياً المحيطة بالملعب

// حدود مستطيل ميدان الملعب (العشب)
const PITCH = { minX: 1800, maxX: 6200, minY: 1800, maxY: 6200 };

/**
 * دالة حساب نصف قطر (حجم) الكرة بناءً على نقاط المستخدم في محفظة Taralali
 * الحجم يعكس الرصيد مباشرة: الحد الأدنى 32px وتكبر المساحة جذرياً مع زيادة النقاط
 */
function calculateRadius(points) {
    const pts = Math.max(0, points || 0);
    return Math.max(32, Math.sqrt(pts) * 0.45);
}

/**
 * دالة جلب أو إنشاء مدرج دولة جديدة ديناميكياً محيطاً بالملعب
 * يتم توزيع مدرجات الدول على الحواف الأربعة (أعلى، يمين، أسفل، يسار) بالتتابع
 */
function getOrCreateCountryStand(countryCode, countryName, flag, countryImage) {
    const code = (countryCode || 'GLOBAL').toUpperCase();
    if (!dynamicStands[code]) {
        const standIndex = Object.keys(dynamicStands).length;
        
        // توزيع المدرجات على الجهات الأربع بشكل متوازن وتلقائي
        // Sides: 0 = Top, 1 = Right, 2 = Bottom, 3 = Left
        const side = standIndex % 4;
        const indexOnSide = Math.floor(standIndex / 4);

        let baseX = 0, baseY = 0;
        const spacing = 1200;

        if (side === 0) {
            // أعلى الملعب (Top Rim)
            baseX = PITCH.minX + 600 + (indexOnSide * spacing);
            baseY = PITCH.minY - 700;
        } else if (side === 1) {
            // يمين الملعب (Right Rim)
            baseX = PITCH.maxX + 700;
            baseY = PITCH.minY + 600 + (indexOnSide * spacing);
        } else if (side === 2) {
            // أسفل الملعب (Bottom Rim)
            baseX = PITCH.minX + 600 + (indexOnSide * spacing);
            baseY = PITCH.maxY + 700;
        } else {
            // يسار الملعب (Left Rim)
            baseX = PITCH.minX - 700;
            baseY = PITCH.minY + 600 + (indexOnSide * spacing);
        }

        dynamicStands[code] = {
            code: code,
            name: countryName || code,
            flag: flag || '🌐',
            countryImage: countryImage || null, // صورة / علم البلد الممثل
            side: side,
            x: baseX,
            y: baseY,
            color: `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}` // لون نيون مميز للمدرج
        };
    }
    return dynamicStands[code];
}

/**
 * دالة إعادة حساب وتوزيع مواقع مقاعد الكرات داخل مدرج الدولة المحيط بالملعب
 */
function recalculateStandPositions(countryCode) {
    const code = (countryCode || 'GLOBAL').toUpperCase();
    const members = Object.values(standVault).filter(p => p.country.code === code);
    const stand = dynamicStands[code];
    if (!stand) return;

    // ترتيب الأعضاء حسب الرصيد (الأكبر نقاطاً يظهر أولاً)
    members.sort((a, b) => b.points - a.points);

    const cols = Math.max(3, Math.ceil(Math.sqrt(members.length)));
    members.forEach((p, idx) => {
        const row = Math.floor(idx / cols);
        const col = idx % cols;

        // التوزيع الشبكي حسب اتجاه المدرج المحيط
        if (stand.side === 0 || stand.side === 2) {
            // مدرجات أفقية (أعلى/أسفل)
            p.x = stand.x + (col - (cols - 1) / 2) * 180;
            p.y = stand.y + (stand.side === 0 ? -row * 150 : row * 150);
        } else {
            // مدرجات رأسية (يمين/يسار)
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
    
    const userId = urlParams.get('userId') || 'user_' + Math.random().toString(36).substr(2, 6);
    const countryCode = (urlParams.get('country') || 'SY').toUpperCase();
    const countryName = urlParams.get('countryName') || countryCode;
    const flag = urlParams.get('flag') || '🇸🇾';
    const countryImage = urlParams.get('countryImage') || null; // رابط أو مسار صورة رمز البلد
    const username = urlParams.get('name') || `لاعب_${userId.substr(0, 4)}`;
    const userPoints = parseInt(urlParams.get('points'), 10) || 25000;

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

            // ⚔️ 1. أمر النزول من المدرج إلى الميدان للمنافسة
            if (data.type === 'ENTER_ARENA' && standVault[userId]) {
                const player = standVault[userId];
                player.inStand = false;
                
                // إنزال الكرة في مكان عشوائي داخل حدود العشب
                player.x = PITCH.minX + 200 + Math.random() * (PITCH.maxX - PITCH.minX - 400);
                player.y = PITCH.minY + 200 + Math.random() * (PITCH.maxY - PITCH.minY - 400);
                player.vx = 0;
                player.vy = 0;

                activePlayers[userId] = player;
                delete standVault[userId];
                
                recalculateStandPositions(player.country.code);
            }

            // 🎯 2. توجيه الحركة في الميدان
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

            // 🔄 3. تحديث نقاط المحفظة من API المنصة
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

    ws.on('close', () => {
        if (activePlayers[userId]) {
            const countryCode = activePlayers[userId].country.code;
            delete activePlayers[userId];
            recalculateStandPositions(countryCode);
        }
    });
});

// ==========================================
// حلقة الفيزياء والابتلاع والخصم اللحظية
// ==========================================
setInterval(() => {
    const activeList = Object.values(activePlayers);

    // تحديث إحداثيات الكرات على العشب
    activeList.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        p.vx *= 0.98;
        p.vy *= 0.98;

        // حماية الخروج خارج خطوط الملعب
        if (p.x - p.radius < PITCH.minX) { p.x = PITCH.minX + p.radius; p.vx = 0; }
        if (p.x + p.radius > PITCH.maxX) { p.x = PITCH.maxX - p.radius; p.vx = 0; }
        if (p.y - p.radius < PITCH.minY) { p.y = PITCH.minY + p.radius; p.vy = 0; }
        if (p.y + p.radius > PITCH.maxY) { p.y = PITCH.maxY - p.radius; p.vy = 0; }
    });

    // منطق الابتلاع والخصم والعودة للمدرج
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

                    // طرد المهزوم وإعادته لمدرج بلده المحيط بالملعب
                    smaller.inStand = true;
                    smaller.vx = 0;
                    smaller.vy = 0;

                    standVault[smaller.id] = smaller;
                    delete activePlayers[smaller.id];

                    recalculateStandPositions(smaller.country.code);
                }
            }
        }
    }

    // بث التحديث الموحد
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
    console.log(`[Taralali Server] Perimeter Dynamic Stadium running on port ${PORT}`);
});