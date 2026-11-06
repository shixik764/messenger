import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const io = new Server(server);

// === Хранилище данных ===
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (existsSync(DATA_FILE)) {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  }
  return { users: [], messages: [] };
}

function saveData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

// Папка uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.static('public'));
app.use('/uploads', express.static(uploadsDir));

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  res.json({
    url: '/uploads/' + req.file.filename,
    name: req.file.originalname,
    type: req.file.mimetype
  });
});

const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);

  // Регистрация
  socket.on('register', (data, callback) => {
    const { username, password } = data;
    const db = loadData();
    
    if (db.users.find(u => u.username === username)) {
      return callback({ success: false, error: 'Имя уже занято' });
    }
    if (username.length < 3 || password.length < 4) {
      return callback({ success: false, error: 'Имя мин. 3 символа, пароль мин. 4' });
    }

    db.users.push({
      username,
      password: hashPassword(password),
      createdAt: new Date().toISOString()
    });
    saveData(db);

    onlineUsers.set(socket.id, username);
    socket.username = username;
    socket.join(username);
    io.emit('users-online', Array.from(onlineUsers.values()));
    callback({ success: true });
  });

  // Логин
  socket.on('login', (data, callback) => {
    const { username, password } = data;
    const db = loadData();
    const user = db.users.find(u => u.username === username);
    
    if (!user) {
      return callback({ success: false, error: 'Пользователь не найден' });
    }
    if (user.password !== hashPassword(password)) {
      return callback({ success: false, error: 'Неверный пароль' });
    }

    onlineUsers.set(socket.id, username);
    socket.username = username;
    socket.join(username);
    io.emit('users-online', Array.from(onlineUsers.values()));
    callback({ success: true });
  });

  // Удаление аккаунта
  socket.on('delete-account', (password, callback) => {
    const username = socket.username;
    const db = loadData();
    const user = db.users.find(u => u.username === username);

    if (!user || user.password !== hashPassword(password)) {
      return callback({ success: false, error: 'Неверный пароль' });
    }

    // Удаляем пользователя и все его сообщения
    db.users = db.users.filter(u => u.username !== username);
    db.messages = db.messages.filter(m => m.from !== username && m.to !== username);
    saveData(db);

    onlineUsers.delete(socket.id);
    io.emit('users-online', Array.from(onlineUsers.values()));
    callback({ success: true });
  });

  // Отправка сообщения
  socket.on('send-message', (data) => {
    const { to, text, fileUrl, fileName, fileType, duration } = data;
    const from = socket.username;

    const db = loadData();
    db.messages.push({
      from,
      to,
      text: text || null,
      fileUrl: fileUrl || null,
      fileName: fileName || null,
      fileType: fileType || null,
      duration: duration || null,
      createdAt: new Date().toISOString()
    });
    saveData(db);

    io.to(to).emit('new-message', {
      from,
      text,
      fileUrl,
      fileName,
      fileType,
      duration,
      time: new Date().toISOString()
    });

    socket.emit('message-sent', {
      to,
      text,
      fileUrl,
      fileName,
      fileType,
      duration,
      time: new Date().toISOString()
    });
  });

  // Загрузка истории
  socket.on('load-history', (otherUser, callback) => {
    const db = loadData();
    const messages = db.messages.filter(m =>
      (m.from === socket.username && m.to === otherUser) ||
      (m.from === otherUser && m.to === socket.username)
    );
    callback(messages);
  });

  socket.on('typing', (to) => {
    socket.to(to).emit('user-typing', socket.username);
  });

  socket.on('stop-typing', (to) => {
    socket.to(to).emit('user-stop-typing', socket.username);
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('users-online', Array.from(onlineUsers.values()));
    console.log('Отключён:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Мессенджер запущен на http://localhost:${PORT}`);
});