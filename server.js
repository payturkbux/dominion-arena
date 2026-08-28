// أضف السرعة للكرات عند إنشائها في server.js
players[playerId] = {
    id: playerId,
    name: `P_${playerId.substr(7)}`,
    country: { code: countryCode, name: countryName, flag: getFlagEmoji(countryCode) },
    points: Math.floor(Math.random() * 30000) + 5000,
    x: Math.random() * 4000 + 1000,
    y: Math.random() * 4000 + 1000,
    vx: (Math.random() - 0.5) * 4,
    vy: (Math.random() - 0.5) * 4,
    radius: Math.max(35, Math.sqrt(Math.floor(Math.random() * 30000) + 5000) * 0.5)
};

// في حلقة البث setInterval، أضف كود تحديث أماكن الكرات:
setInterval(() => {
    // تحديث أماكن الكرات تلقائياً في السيرفر
    Object.values(players).forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        // ارتداد من الجدران
        if (p.x < 100 || p.x > 5900) p.vx *= -1;
        if (p.y < 100 || p.y > 5900) p.vy *= -1;
    });

    const payload = JSON.stringify({ type: 'SYNC', players });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 40); // 25 FPS