const http = require('http');
const expressApp = require('express');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = expressApp();
const server = http.createServer(app);
const io = new Server(server);
app.expressApp = expressApp; // للتوافقية
app.use(expressApp.json({ limit: '10mb' }));
app.use(expressApp.urlencoded({ limit: '10mb', extended: true }));
app.use(expressApp.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// إعداد قاعدة البيانات SQLite
const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error('خطأ في الاتصال بقاعدة البيانات', err.message);
    else console.log('تم الاتصال بقاعدة البيانات بنجاح.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT,
        sender TEXT,
        avatar TEXT,
        message TEXT,
        type TEXT,
        timestamp TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS private_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        recipient TEXT,
        avatar TEXT,
        message TEXT,
        type TEXT,
        timestamp TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user1 TEXT,
        user2 TEXT,
        status TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        banned_until INTEGER
    )`);
});

const activeUsers = {}; // socket.id -> { username, avatar, room }
const roomMics = {
    'العامة': { 0: null, 1: null, 2: null, 3: null },
    'ملوك مصر': { 0: null, 1: null, 2: null, 3: null },
    'ملوك المغرب': { 0: null, 1: null, 2: null, 3: null },
    'ملوك الجزائر': { 0: null, 1: null, 2: null, 3: null }
};

function getRoomCounts() {
    const counts = { 'العامة': 0, 'ملوك مصر': 0, 'ملوك المغرب': 0, 'ملوك الجزائر': 0 };
    Object.values(activeUsers).forEach(u => {
        if (counts[u.room] !== undefined) counts[u.room]++;
    });
    return counts;
}

function updateUsersAndCounts() {
    const activeUsersList = Object.values(activeUsers);
    io.emit('update users', activeUsersList);
    io.emit('update room counts', getRoomCounts());
}

io.on('connection', (socket) => {
    console.log('مستخدم متصل:', socket.id);

    // تسجيل حساب جديد
    socket.on('register', ({ username, password, avatar }, callback) => {
        if (!username || !password) return callback({ success: false, message: 'الرجاء إدخال الحقول المطلوبة' });
        
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
            if (row) return callback({ success: false, message: 'اسم المستخدم مستخدم مسبقاً!' });

            db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, [username, password, avatar || '👤'], function(err) {
                if (err) return callback({ success: false, message: 'حدث خطأ أثناء التسجيل' });
                callback({ success: true, message: 'تم إنشاء الحساب بنجاح! يمكنك تسجيل الدخول الآن.' });
            });
        });
    });

    // تسجيل الدخول
    socket.on('login', ({ username, password }, callback) => {
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
            if (!user || user.password !== password) {
                return callback({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة!' });
            }

            // التحقق من الحظر
            db.get(`SELECT * FROM bans WHERE username = ?`, [username], (err, ban) => {
                if (ban && ban.banned_until > Date.now()) {
                    const remainingMins = Math.ceil((ban.banned_until - Date.now()) / 60000);
                    return callback({ success: false, message: `حسابك محظور. باقي ${remainingMins} دقائق.` });
                }

                // تسجيل خروج أي جلسة قديمة لنفس المستخدم لمنع التكرار
                for (const [sId, uData] of Object.entries(activeUsers)) {
                    if (uData.username === username) {
                        delete activeUsers[sId];
                        io.sockets.sockets.get(sId)?.disconnect();
                    }
                }

                activeUsers[socket.id] = { username, avatar: user.avatar || '👤', room: 'العامة' };
                callback({ success: true, message: 'تم تسجيل الدخول بنجاح', username, avatar: user.avatar });
                
                updateUsersAndCounts();
                socket.join('العامة');

                // إرسال رسائل الغرفة العامة للمستخدم عند دخوله
                db.all(`SELECT * FROM messages WHERE room = 'العامة' ORDER BY id ASC`, [], (err, rows) => {
                    socket.emit('load room messages', rows);
                });
            });
        });
    });

    // تغيير صورة البروفيل
    socket.on('update avatar', ({ newAvatar }, callback) => {
        const user = activeUsers[socket.id];
        if (!user) return callback({ success: false, message: 'غير مسجل الدخول' });

        db.run(`UPDATE users SET avatar = ? WHERE username = ?`, [newAvatar, user.username], (err) => {
            if (err) return callback({ success: false, message: 'خطأ في تحديث الصورة' });
            
            user.avatar = newAvatar;
            // تحديث الصورة في المايكات إذا كان صاعداً
            for (const roomName in roomMics) {
                for (let i = 0; i < 4; i++) {
                    if (roomMics[roomName][i] && roomMics[roomName][i].username === user.username) {
                        roomMics[roomName][i].avatar = newAvatar;
                    }
                }
                io.to(roomName).emit('update mics', roomMics[roomName]);
            }

            updateUsersAndCounts();
            callback({ success: true, message: 'تم تحديث الصورة الشخصية بنجاح!', avatar: newAvatar });
        });
    });

    // تغيير كلمة المرور
    socket.on('change password', ({ oldPassword, newPassword }, callback) => {
        const user = activeUsers[socket.id];
        if (!user) return callback({ success: false, message: 'غير مسجل الدخول' });

        db.get(`SELECT * FROM users WHERE username = ?`, [user.username], (err, dbUser) => {
            if (!dbUser || dbUser.password !== oldPassword) {
                return callback({ success: false, message: 'كلمة المرور القديمة غير صحيحة!' });
            }

            db.run(`UPDATE users SET password = ? WHERE username = ?`, [newPassword, user.username], (err) => {
                if (err) return callback({ success: false, message: 'خطأ في تغيير كلمة المرور' });
                callback({ success: true, message: 'تم تغيير كلمة المرور بنجاح!' });
            });
        });
    });

    // الانضمام لغرفة
    socket.on('join room', (roomName) => {
        const user = activeUsers[socket.id];
        if (!user) return;

        socket.leave(user.room);
        user.room = roomName;
        socket.join(roomName);

        updateUsersAndCounts();
        io.to(roomName).emit('update mics', roomMics[roomName]);

        // جلب رسائل الغرفة وسجلها كاملاً دون حذف
        db.all(`SELECT * FROM messages WHERE room = ? ORDER BY id ASC`, [roomName], (err, rows) => {
            socket.emit('load room messages', rows);
        });
    });

    // إرسال رسالة في الغرفة العامة
    socket.on('chat message', ({ message, type }) => {
        const user = activeUsers[socket.id];
        if (!user) return;

        const time = new Date().toLocaleTimeString();
        const msgData = { room: user.room, sender: user.username, avatar: user.avatar, message, type: type || 'text', timestamp: time };

        db.run(`INSERT INTO messages (room, sender, avatar, message, type, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
            [user.room, user.username, user.avatar, message, type || 'text', time], () => {
                io.to(user.room).emit('chat message', msgData);
            });
    });

    // تحميل رسائل الخاص السابقة
    socket.on('load private history', ({ peer }) => {
        const user = activeUsers[socket.id];
        if (!user) return;

        db.all(`SELECT * FROM private_messages WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?) ORDER BY id ASC`,
            [user.username, peer, peer, user.username], (err, rows) => {
                socket.emit('load private messages', { peer, messages: rows });
            });
    });

    // إرسال رسالة خاصة
    socket.on('private message', ({ recipient, message, type }) => {
        const user = activeUsers[socket.id];
        if (!user) return;

        const time = new Date().toLocaleTimeString();
        const msgData = { sender: user.username, recipient, avatar: user.avatar, message, type: type || 'text', timestamp: time };

        db.run(`INSERT INTO private_messages (sender, recipient, avatar, message, type, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
            [user.username, recipient, user.avatar, message, type || 'text', time], () => {
                // إرسال للمستقبل إن كان متصلاً
                for (const [sId, uData] of Object.entries(activeUsers)) {
                    if (uData.username === recipient) {
                        io.to(sId).emit('private message', msgData);
                        break;
                    }
                }
            });
    });

    // المايكات الصوتية
    socket.on('join mic', ({ room, micIndex, audioUrl }) => {
        const user = activeUsers[socket.id];
        if (!user) return;

        roomMics[room][micIndex] = { username: user.username, avatar: user.avatar, audioUrl };
        io.to(room).emit('update mics', roomMics[room]);
    });

    socket.on('leave mic', ({ room, micIndex }) => {
        if (roomMics[room] && roomMics[room][micIndex]) {
            roomMics[room][micIndex] = null;
            io.to(room).emit('update mics', roomMics[room]);
        }
    });

    // طلبات الصداقة والحظر
    socket.on('send friend request', ({ recipient }) => {
        const user = activeUsers[socket.id];
        if (!user) return;

        for (const [sId, uData] of Object.entries(activeUsers)) {
            if (uData.username === recipient) {
                io.to(sId).emit('friend request received', { from: user.username });
                break;
            }
        }
    });

    socket.on('respond friend request', ({ fromUser, action }) => {
        const user = activeUsers[socket.id];
        if (!user) return;

        for (const [sId, uData] of Object.entries(activeUsers)) {
            if (uData.username === fromUser) {
                io.to(sId).emit('friend request response', { from: user.username, action });
                break;
            }
        }
    });

    socket.on('ban user', ({ targetUsername, durationMinutes }) => {
        const user = activeUsers[socket.id];
        if (!user || user.username !== 'Admin') return;

        const bannedUntil = Date.now() + (durationMinutes * 60 * 1000);
        db.run(`INSERT INTO bans (username, banned_until) VALUES (?, ?)`, [targetUsername, bannedUntil], () => {
            for (const [sId, uData] of Object.entries(activeUsers)) {
                if (uData.username === targetUsername) {
                    io.to(sId).emit('error msg', `تم حظرك من قبل الأدمن لمدة ${durationMinutes} دقائق.`);
                    io.sockets.sockets.get(sId)?.disconnect();
                    break;
                }
            }
        });
    });

    socket.on('disconnect', () => {
        if (activeUsers[socket.id]) {
            const userRoom = activeUsers[socket.id].room;
            const username = activeUsers[socket.id].username;

            // إنزال المستخدم من المايكات إذا كان صاعداً
            for (const roomName in roomMics) {
                for (let i = 0; i < 4; i++) {
                    if (roomMics[roomName][i] && roomMics[roomName][i].username === username) {
                        roomMics[roomName][i] = null;
                        io.to(roomName).emit('update mics', roomMics[roomName]);
                    }
                }
            }

            delete activeUsers[socket.id];
            updateUsersAndCounts();
        }
        console.log('مستخدم منفصل:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`السيرفر يعمل على المنفذ ${PORT}`);
});