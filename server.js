const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STAND_LOCATIONS = {
    "SY": { x: 1200, y: 1100 },
    "SA": { x: 2400, y: 1100 },
    "TR": { x: 3600, y: 1100 },
    "EG": { x: 4800, y: 1100 },
    "AE": { x: 6000, y: 1100 }
};

let activePlayers = {}; 
let standVault = {};    

// 📥 جلب المستخدمين الخاملين من Supabase لملء المدرجات
async function loadOfflinePlayersToStands() {
    try {
        const { data: users, error } = await supabase
            .from('profiles')
            .select('id, display_name, points_balance, tier, country_code')
            .limit(50);

        if (users && !error) {
            users.forEach(u => {
                const country = u.country_code || 'SY';
                const stand = STAND_LOCATIONS[country] || STAND_LOCATIONS['SY'];
                
                standVault[u.id] = {
                    id: u.id,
                    name: u.display_name || 'لاعب',
                    points: u.points_balance || 0,
                    tier: u.tier || 'Bronze',
                    inStand: true,
                    x: stand.x + (Math.random() * 400 - 200),
                    y: stand.y + (Math.random() * 200 - 100),
                    radius: 35,
                    country: { code: country }
                };
            });
        }
    } catch (err) {
        console.error("خطأ في تحميل بيانات مدرجات Supabase:", err);
    }
}

// تحميل الجمهور إلى المدرجات عند تشغيل السيرفر
loadOfflinePlayersToStands();

wss.on('connection', async (ws, req) => {
    const urlParams = new URLSearchParams(req.url.replace(/^.*\?/, ''));
    const userId = urlParams.get('userId');
    const socketId = userId || 'user_' + Math.random().toString(36).substr(2, 9);

    ws.id = socketId;

    // إرسال معرف الجلسة
    ws.send(JSON.stringify({ type: 'INIT', selfId: socketId }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // عند النقر ينزل اللاعب من المدرج إلى الساحة
            if (data.type === 'ENTER_ARENA') {
                let player = standVault[socketId];
                if (!player) {
                    player = {
                        id: socketId,
                        name: 'لاعب نشط',
                        points: 100,
                        tier: 'Bronze',
                        country: { code: 'SY' }
                    };
                } else {
                    delete standVault[socketId]; // إزالته من الخاملين بالمدرج
                }
                
                player.inStand = false;
                player.x = data.targetX || 3600;
                player.y = data.targetY || 3700;
                player.targetX = player.x;
                player.targetY = player.y;
                
                activePlayers[socketId] = player;
            } else if (data.type === 'TARGET') {
                if (activePlayers[socketId]) {
                    activePlayers[socketId].targetX = data.x;
                    activePlayers[socketId].targetY = data.y;
                }
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        // إعادة اللاعب إلى المدرج إذا قطع الاتصال
        if (activePlayers[socketId]) {
            const player = activePlayers[socketId];
            delete activePlayers[socketId];
            player.inStand = true;
            const stand = STAND_LOCATIONS[player.country?.code] || STAND_LOCATIONS['SY'];
            player.x = stand.x;
            player.y = stand.y;
            standVault[socketId] = player;
        }
    });
});

// بث التحديثات المستمرة للواجهة (30 FPS)
setInterval(() => {
    Object.values(activePlayers).forEach(p => {
        if (p.targetX !== undefined && p.targetY !== undefined) {
            p.x += (p.targetX - p.x) * 0.15;
            p.y += (p.targetY - p.y) * 0.15;
        }
    });

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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));