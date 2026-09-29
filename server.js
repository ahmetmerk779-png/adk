const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const botMap = new Map();
const logs = [];

function addLog(botName, msg, type = 'info') {
    const time = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { time, botName, msg, type };
    logs.push(logEntry);
    if (logs.length > 400) logs.shift();
    io.emit('log', logEntry);
    console.log(`[${time}] [${botName}] (${type.toUpperCase()}) ${msg}`);
}

function emitBotStates() {
    const botStates = [];
    botMap.forEach((val, id) => {
        botStates.push({
            id,
            username: val.username,
            status: val.status,
            health: val.health || 20,
            food: val.food || 20,
            pos: val.pos || { x: 0, y: 0, z: 0 }
        });
    });
    io.emit('botListUpdate', botStates);
}

function createSingleBot(options) {
    const {
        host, port, version, username, id,
        autoReconnect, reconnectDelay,
        autoLogin, password, antiAfkMode
    } = options;

    if (botMap.has(id)) {
        const existing = botMap.get(id);
        if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
        if (existing.afkInterval) clearInterval(existing.afkInterval);
        if (existing.bot) {
            try { existing.bot.end(); } catch (e) {}
        }
    }

    botMap.set(id, {
        bot: null,
        status: 'Bağlanıyor...',
        username,
        options,
        manualStop: false,
        reconnectTimer: null,
        afkInterval: null,
        health: 20,
        food: 20,
        pos: { x: 0, y: 0, z: 0 },
        autoReconnect: autoReconnect !== false
    });

    emitBotStates();
    addLog(username, `${host}:${port} sunucusuna erişim sağlanıyor...`, 'info');

    const botOptions = {
        host: host.trim(),
        port: parseInt(port) || 25565,
        username: username.trim(),
        auth: 'offline', // Korsan/Offline sunucular için kritik zorunlu ayar
        checkTimeoutInterval: 30000
    };

    if (version && version !== 'auto') {
        botOptions.version = version;
    }

    let bot;
    try {
        bot = mineflayer.createBot(botOptions);
    } catch (err) {
        addLog(username, `Başlatma Hatası: ${err.message}`, 'error');
        return;
    }

    const currentEntry = botMap.get(id);
    currentEntry.bot = bot;

    // --- ETKİNLİKLER --- //

    bot.on('login', () => {
        currentEntry.status = 'Giriş Yapıldı (Doğuluyor...)';
        emitBotStates();
        addLog(username, 'Sunucu paketi kabul etti, dünyaya giriş bekleniyor...', 'info');
    });

    bot.once('spawn', () => {
        currentEntry.status = 'Aktif (Oyunda)';
        emitBotStates();
        addLog(username, 'Dünyada başarıyla doğdu!', 'success');

        // Otomatik Komut / Şifre Girişi
        if (autoLogin && password) {
            setTimeout(() => {
                if (currentEntry.status.includes('Aktif')) {
                    bot.chat(`/login ${password}`);
                    bot.chat(`/register ${password} ${password}`);
                    addLog(username, 'Auto-Login / Register komutları iletildi.', 'cmd');
                }
            }, 2500);
        }

        startAntiAfkRoutine(currentEntry, antiAfkMode);
    });

    bot.on('health', () => {
        if (bot.health !== undefined) currentEntry.health = Math.round(bot.health);
        if (bot.food !== undefined) currentEntry.food = Math.round(bot.food);
        emitBotStates();
    });

    bot.on('move', () => {
        if (bot.entity && bot.entity.position) {
            currentEntry.pos = {
                x: Math.round(bot.entity.position.x),
                y: Math.round(bot.entity.position.y),
                z: Math.round(bot.entity.position.z)
            };
        }
    });

    bot.on('death', () => {
        addLog(username, 'Bot öldü! Yeniden doğuluyor...', 'warn');
        setTimeout(() => {
            try { bot.respawn(); } catch (e) {}
        }, 1500);
    });

    bot.on('message', (message) => {
        const txt = message.toString().trim();
        if (txt) addLog(username, txt, 'chat');
    });

    function handleDisconnect(reason) {
        if (currentEntry.afkInterval) clearInterval(currentEntry.afkInterval);
        if (currentEntry.manualStop) return;

        if (currentEntry.autoReconnect) {
            const delaySec = parseInt(reconnectDelay) || 5;
            currentEntry.status = `Yeniden Bağlanıyor (${delaySec}s)`;
            emitBotStates();
            addLog(username, `${reason} - ${delaySec} sn sonra tekrar denenecek.`, 'warn');

            currentEntry.reconnectTimer = setTimeout(() => {
                if (!currentEntry.manualStop) {
                    createSingleBot(options);
                }
            }, delaySec * 1000);
        } else {
            currentEntry.status = 'Kapalı';
            emitBotStates();
            addLog(username, `${reason} - Otomatik tekrar bağlanma kapalı.`);
        }
    }

    bot.on('kicked', (reason) => {
        let parsedReason = reason;
        try { parsedReason = JSON.parse(reason).text || reason; } catch(e) {}
        addLog(username, `Atıldı: ${parsedReason}`, 'error');
        handleDisconnect('Sunucudan Atıldı');
    });

    bot.on('end', (reason) => {
        if (!currentEntry.manualStop && !currentEntry.status.includes('Yeniden Bağlanıyor')) {
            handleDisconnect(`Bağlantı Sonlandı (${reason || 'Bilinmeyen Nedun'})`);
        } else if (currentEntry.manualStop) {
            currentEntry.status = 'Kapalı';
            emitBotStates();
            addLog(username, 'Bağlantı manuel kapatıldı.');
        }
    });

    bot.on('error', (err) => {
        addLog(username, `Bağlantı Hatası: ${err.message}`, 'error');
    });
}

function startAntiAfkRoutine(entry, mode) {
    if (entry.afkInterval) clearInterval(entry.afkInterval);

    entry.afkInterval = setInterval(() => {
        const bot = entry.bot;
        if (!bot || !entry.status.includes('Aktif')) return;

        try {
            if (mode === 'jump' || mode === 'combo') {
                bot.setControlState('jump', true);
                setTimeout(() => bot.setControlState('jump', false), 350);
            }
            if (mode === 'sneak' || mode === 'combo') {
                setTimeout(() => {
                    bot.setControlState('sneak', true);
                    setTimeout(() => bot.setControlState('sneak', false), 600);
                }, 800);
            }
            if (mode === 'look' || mode === 'combo') {
                const yaw = (Math.random() * Math.PI * 2) - Math.PI;
                const pitch = (Math.random() * Math.PI / 4) - (Math.PI / 8);
                bot.look(yaw, pitch, true);
            }
        } catch (e) {}
    }, 45000); // 45 Saniyede bir Anti-AFK hareketi
}

io.on('connection', (socket) => {
    emitBotStates();
    socket.emit('logs', logs);

    socket.on('startMultipleBots', (data) => {
        const {
            host, port, version, prefix, count, customNames,
            autoReconnect, reconnectDelay, autoLogin, password, antiAfkMode, joinDelay
        } = data;

        let namesToUse = [];
        if (customNames && customNames.trim().length > 0) {
            namesToUse = customNames.split(',').map(n => n.trim()).filter(n => n.length > 0);
        } else {
            const total = parseInt(count) || 1;
            for (let i = 1; i <= total; i++) {
                namesToUse.push(`${prefix}_${i}`);
            }
        }

        const delayBetweenJoins = (parseInt(joinDelay) || 3.5) * 1000;

        namesToUse.forEach((name, index) => {
            const botId = `bot_${name}`;
            setTimeout(() => {
                createSingleBot({
                    host,
                    port,
                    version,
                    username: name,
                    id: botId,
                    autoReconnect: autoReconnect !== false,
                    reconnectDelay: reconnectDelay || 5,
                    autoLogin,
                    password,
                    antiAfkMode: antiAfkMode || 'combo'
                });
            }, index * delayBetweenJoins); // Anti-Bot yakalanmamak için sırayla girtir
        });
    });

    socket.on('sendChat', (data) => {
        const { target, message } = data;
        if (!message || message.trim().length === 0) return;

        if (target === 'all') {
            let sentCount = 0;
            botMap.forEach((val) => {
                if (val.bot && val.status.includes('Aktif')) {
                    val.bot.chat(message);
                    sentCount++;
                }
            });
            addLog('TOPLU CHAT', `[${sentCount} Bot] -> ${message}`, 'cmd');
        } else {
            if (botMap.has(target)) {
                const item = botMap.get(target);
                if (item.bot && item.status.includes('Aktif')) {
                    item.bot.chat(message);
                    addLog(item.username, `[GÖNDERİLDİ] ${message}`, 'cmd');
                } else {
                    addLog('SİSTEM', `${item.username} oyunda değil!`, 'error');
                }
            }
        }
    });

    socket.on('stopBot', (botId) => {
        if (botMap.has(botId)) {
            const item = botMap.get(botId);
            item.manualStop = true;
            if (item.reconnectTimer) clearTimeout(item.reconnectTimer);
            if (item.afkInterval) clearInterval(item.afkInterval);
            if (item.bot) try { item.bot.end(); } catch(e){}
            item.status = 'Kapatıldı';
            emitBotStates();
            addLog(item.username, 'Bot durduruldu.');
        }
    });

    socket.on('stopAllBots', () => {
        botMap.forEach((val) => {
            val.manualStop = true;
            if (val.reconnectTimer) clearTimeout(val.reconnectTimer);
            if (val.afkInterval) clearInterval(val.afkInterval);
            if (val.bot) try { val.bot.end(); } catch(e){}
            val.status = 'Kapatıldı';
        });
        emitBotStates();
        addLog('SİSTEM', 'Tüm botlar durduruldu.', 'warn');
    });
});

setInterval(() => {
    http.get(`http://localhost:${PORT}`, () => {}).on('error', () => {});
}, 300000);

server.listen(PORT, () => {
    console.log(`[SİSTEM] Mobil Uyumlu Bot Manager ${PORT} portunda çalışıyor.`);
});
