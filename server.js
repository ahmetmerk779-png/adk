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

// Bot Veri Deposu
const botMap = new Map();
const logs = [];

// Log Ekleme Fonksiyonu
function addLog(botName, msg, type = 'info') {
    const time = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { time, botName, msg, type };
    logs.push(logEntry);
    if (logs.length > 300) logs.shift();
    io.emit('log', logEntry);
    console.log(`[${time}] [${botName}] ${msg}`);
}

// Arayüze Bot Durumlarını Gönder
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

// Bot Oluşturma Ana Fonksiyonu
function createSingleBot(options) {
    const {
        host, port, version, username, id,
        autoReconnect, reconnectDelay,
        autoLogin, password, antiAfkMode
    } = options;

    // Önceki izleri temizle
    if (botMap.has(id)) {
        const existing = botMap.get(id);
        if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
        if (existing.afkInterval) clearInterval(existing.afkInterval);
        if (existing.bot) {
            try { existing.bot.quit(); } catch (e) {}
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
    addLog(username, 'Sunucuya bağlanıyor...');

    const bot = mineflayer.createBot({
        host,
        port: parseInt(port) || 25565,
        username,
        version: version && version !== 'auto' ? version : false
    });

    const currentEntry = botMap.get(id);
    currentEntry.bot = bot;

    // --- BOT ETKİNLİKLERİ --- //

    bot.on('login', () => {
        currentEntry.status = 'Aktif (AFK)';
        emitBotStates();
        addLog(username, `${host}:${port} sunucusuna giriş yapıldı.`, 'success');

        // Otomatik Giriş / Kayıt
        if (autoLogin && password) {
            setTimeout(() => {
                bot.chat(`/login ${password}`);
                bot.chat(`/register ${password} ${password}`);
                addLog(username, 'Auto-Login/Register komutu gönderildi.', 'cmd');
            }, 2000);
        }

        // Anti-AFK Rutini Oluştur
        startAntiAfkRoutine(currentEntry, antiAfkMode);
    });

    // Can / Açlık / Konum Güncellemeleri
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

    // Otomatik Yeniden Doğma (Auto Respawn)
    bot.on('death', () => {
        addLog(username, 'Bot öldü! Otomatik yeniden doğunuyor...', 'warn');
        setTimeout(() => {
            try {
                bot.respawn();
                addLog(username, 'Yeniden doğdu.', 'success');
            } catch (e) {
                addLog(username, `Yeniden doğma hatası: ${e.message}`, 'error');
            }
        }, 1000);
    });

    // Chat Mesajları
    bot.on('message', (message) => {
        addLog(username, message.toString(), 'chat');
    });

    // Kopma ve Hata Yönetimi
    function handleDisconnect(reason) {
        if (currentEntry.afkInterval) clearInterval(currentEntry.afkInterval);
        if (currentEntry.manualStop) return;

        if (currentEntry.autoReconnect) {
            const delaySec = parseInt(reconnectDelay) || 5;
            currentEntry.status = `Yeniden Bağlanıyor (${delaySec}s)`;
            emitBotStates();
            addLog(username, `${reason} - ${delaySec} sn sonra tekrar bağlanılacak...`, 'warn');

            currentEntry.reconnectTimer = setTimeout(() => {
                if (!currentEntry.manualStop) {
                    createSingleBot(options);
                }
            }, delaySec * 1000);
        } else {
            currentEntry.status = 'Kapalı';
            emitBotStates();
            addLog(username, `${reason} - Otomatik bağlanma kapalı.`);
        }
    }

    bot.on('kicked', (reason) => {
        addLog(username, `Sunucudan atıldı: ${reason}`, 'error');
        handleDisconnect('Atıldı');
    });

    bot.on('end', () => {
        if (!currentEntry.manualStop && !currentEntry.status.includes('Yeniden Bağlanıyor')) {
            addLog(username, 'Sunucu bağlantısı koptu.');
            handleDisconnect('Bağlantı Koptu');
        } else if (currentEntry.manualStop) {
            currentEntry.status = 'Kapalı';
            emitBotStates();
            addLog(username, 'Bağlantı kesildi (Durduruldu).');
        }
    });

    bot.on('error', (err) => {
        addLog(username, `Hata: ${err.message}`, 'error');
    });
}

// Anti-AFK Hareket Mantığı
function startAntiAfkRoutine(entry, mode) {
    if (entry.afkInterval) clearInterval(entry.afkInterval);

    entry.afkInterval = setInterval(() => {
        const bot = entry.bot;
        if (!bot || entry.status !== 'Aktif (AFK)') return;

        try {
            if (mode === 'jump' || mode === 'combo') {
                bot.setControlState('jump', true);
                setTimeout(() => bot.setControlState('jump', false), 400);
            }

            if (mode === 'sneak' || mode === 'combo') {
                setTimeout(() => {
                    bot.setControlState('sneak', true);
                    setTimeout(() => bot.setControlState('sneak', false), 800);
                }, 1000);
            }

            if (mode === 'look' || mode === 'combo') {
                const yaw = (Math.random() * Math.PI * 2) - Math.PI;
                const pitch = (Math.random() * Math.PI / 2) - (Math.PI / 4);
                bot.look(yaw, pitch, true);
            }
        } catch (e) {}
    }, 60000); // 1 Dakikada bir hareket döngüsü
}

// Socket.io İletişim Hattı
io.on('connection', (socket) => {
    emitBotStates();
    socket.emit('logs', logs);

    // Toplu Bot Başlat
    socket.on('startMultipleBots', (data) => {
        const {
            host, port, version, prefix, count, customNames,
            autoReconnect, reconnectDelay, autoLogin, password, antiAfkMode
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
            }, index * 1500);
        });
    });

    // Chat / Komut Gönder
    socket.on('sendChat', (data) => {
        const { target, message } = data;
        if (!message || message.trim().length === 0) return;

        if (target === 'all') {
            let sentCount = 0;
            botMap.forEach((val) => {
                if (val.bot && val.status === 'Aktif (AFK)') {
                    val.bot.chat(message);
                    addLog(val.username, `[GÖNDERİLDİ] ${message}`, 'cmd');
                    sentCount++;
                }
            });
            if (sentCount === 0) addLog('SİSTEM', 'Aktif bot bulunamadı.', 'error');
        } else {
            if (botMap.has(target)) {
                const item = botMap.get(target);
                if (item.bot && item.status === 'Aktif (AFK)') {
                    item.bot.chat(message);
                    addLog(item.username, `[GÖNDERİLDİ] ${message}`, 'cmd');
                } else {
                    addLog('SİSTEM', `${item.username} aktif değil!`, 'error');
                }
            }
        }
    });

    // Bot Durdurma İşlemleri
    socket.on('stopBot', (botId) => {
        if (botMap.has(botId)) {
            const item = botMap.get(botId);
            item.manualStop = true;
            if (item.reconnectTimer) clearTimeout(item.reconnectTimer);
            if (item.afkInterval) clearInterval(item.afkInterval);
            if (item.bot) item.bot.quit();
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
            if (val.bot) val.bot.quit();
            val.status = 'Kapatıldı';
        });
        emitBotStates();
        addLog('SİSTEM', 'Tüm botlar durduruldu.', 'warn');
    });
});

// Render Keep-Alive Self Ping (Her 5 dakikada bir)
setInterval(() => {
    http.get(`http://localhost:${PORT}`, () => {}).on('error', () => {});
}, 300000);

server.listen(PORT, () => {
    console.log(`[SİSTEM] Gelişmiş Terminal Dashboard ${PORT} portunda aktif.`);
});
