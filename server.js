const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./database');
const aiEngine = require('./ai_engine');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'biosync-super-secret-key-12345';

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token missing' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// Admin check middleware
const requireAdmin = async (req, res, next) => {
  try {
    const user = await db.get('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Restricted to administrators' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Internal server check failed' });
  }
};

// --- AUTHENTICATION API ---

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, onboardingAnswers = {} } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const existing = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ error: 'Account with this email already exists' });
    }

    // Map onboarding answers to wellnessGoals and hobbies for legacy features compatibility
    const q1 = onboardingAnswers.q1 || '';
    const wellnessGoals = q1 ? [q1] : [];
    const q7 = onboardingAnswers.q7 || [];
    const hobbies = [];
    q7.forEach(h => {
      const lower = h.toLowerCase();
      if (lower.includes('reading') || lower.includes('journaling')) hobbies.push('reading');
      else if (lower.includes('music') || lower.includes('creative')) hobbies.push('guitar');
      else if (lower.includes('gaming') || lower.includes('puzzles')) hobbies.push('gaming');
      else if (lower.includes('cooking') || lower.includes('baking')) hobbies.push('cooking');
      else if (lower.includes('coding') || lower.includes('building')) hobbies.push('coding');
      else if (lower.includes('running') || lower.includes('cardio') || lower.includes('cycling') || lower.includes('strength') || lower.includes('hiking') || lower.includes('sports') || lower.includes('yoga') || lower.includes('pilates')) {
        hobbies.push('basketball');
      } else {
        hobbies.push(h);
      }
    });

    const hash = await bcrypt.hash(password, 10);
    const result = await db.run(
      'INSERT INTO users (email, password_hash, role, wellness_goals, hobbies, onboarding_answers) VALUES (?, ?, ?, ?, ?, ?)',
      [email, hash, 'user', JSON.stringify(wellnessGoals), JSON.stringify(hobbies), JSON.stringify(onboardingAnswers)]
    );

    const token = jwt.sign({ id: result.id, email, role: 'user' }, JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({ token, user: { id: result.id, email, role: 'user', wellnessGoals, hobbies, onboardingAnswers } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const wellnessGoals = JSON.parse(user.wellness_goals || '[]');
    const hobbies = JSON.parse(user.hobbies || '[]');
    const onboardingAnswers = JSON.parse(user.onboarding_answers || '{}');

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, wellnessGoals, hobbies, onboardingAnswers } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.get('SELECT id, email, role, wellness_goals, hobbies, onboarding_answers, telegram_chat_id FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      wellnessGoals: JSON.parse(user.wellness_goals || '[]'),
      hobbies: JSON.parse(user.hobbies || '[]'),
      onboardingAnswers: JSON.parse(user.onboarding_answers || '{}'),
      telegramConnected: !!user.telegram_chat_id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Profile settings
app.put('/api/auth/profile', authenticateToken, async (req, res) => {
  const { email, password, wellnessGoals, hobbies } = req.body;
  const userId = req.user.id;

  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let query = 'UPDATE users SET email = ?, wellness_goals = ?, hobbies = ?';
    let params = [
      email || user.email,
      wellnessGoals ? JSON.stringify(wellnessGoals) : user.wellness_goals,
      hobbies ? JSON.stringify(hobbies) : user.hobbies
    ];

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      query += ', password_hash = ?';
      params.push(hash);
    }

    query += ' WHERE id = ?';
    params.push(userId);

    await db.run(query, params);

    const updated = await db.get('SELECT id, email, role, wellness_goals, hobbies FROM users WHERE id = ?', [userId]);
    res.json({
      message: 'Profile updated successfully',
      user: {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        wellnessGoals: JSON.parse(updated.wellness_goals || '[]'),
        hobbies: JSON.parse(updated.hobbies || '[]')
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- TELEGRAM BOT INTEGRATION API ---

app.post('/api/telegram/generate-pin', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    // Generate a random 6-digit number
    const rawPin = Math.floor(100000 + Math.random() * 900000).toString();
    const formattedPin = `${rawPin.slice(0, 3)}-${rawPin.slice(3)}`;

    // Store in DB (raw 6-digit code for easier matching)
    await db.run('UPDATE users SET telegram_pin = ? WHERE id = ?', [rawPin, userId]);

    res.json({ pin: formattedPin, botUsername: 'biosync_robot' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/telegram/status', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await db.get('SELECT telegram_chat_id, telegram_pin FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let formattedPin = null;
    if (user.telegram_pin) {
      formattedPin = `${user.telegram_pin.slice(0, 3)}-${user.telegram_pin.slice(3)}`;
    }

    res.json({
      connected: !!user.telegram_chat_id,
      pin: formattedPin,
      botUsername: 'biosync_robot'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- BIOMETRICS & INGESTION API ---


app.post('/api/sessions/submit', authenticateToken, async (req, res) => {
  const { heartRate, sleepHours, waterMl, stressLevel, fatigueBlinkRate, fatigueScore, faceSnapshotUrl, steps, activeMinutes } = req.body;
  const userId = req.user.id;

  if (heartRate == null || sleepHours == null || waterMl == null || stressLevel == null) {
    return res.status(400).json({ error: 'Missing required session parameters' });
  }

  try {
    // 1. Fetch user goals and hobbies
    const user = await db.get('SELECT wellness_goals, hobbies, telegram_chat_id FROM users WHERE id = ?', [userId]);
    const wellnessGoals = JSON.parse(user.wellness_goals || '[]');
    const hobbies = JSON.parse(user.hobbies || '[]');

    // 2. Save session to DB
    const sessionResult = await db.run(`
      INSERT INTO sessions (user_id, heart_rate, sleep_hours, water_ml, stress_level, fatigue_blink_rate, fatigue_score, face_snapshot_url, steps, active_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [userId, heartRate, sleepHours, waterMl, stressLevel, fatigueBlinkRate || 0, fatigueScore || 0, faceSnapshotUrl || '', steps || 0, activeMinutes || 0]);
    
    const sessionId = sessionResult.id;

    // 3. Coordinate with AI Engine for Nudge
    const aiResult = await aiEngine.analyzeStateAndGenerateNudge({
      heartRate,
      sleepHours,
      waterMl,
      stressLevel,
      fatigueScore: fatigueScore || 0,
      hobbies,
      wellnessGoals,
      faceSnapshotUrl
    });

    // 4. Save Nudge & Assessment to DB
    const assessmentPayload = JSON.stringify({
      assessment: aiResult.assessment,
      insights: aiResult.insights
    });

    await db.run(`
      INSERT INTO ai_nudges (session_id, user_id, nudge_text, hobby_targeted, assessment_text)
      VALUES (?, ?, ?, ?, ?)
    `, [sessionId, userId, aiResult.nudge, aiResult.targetHobby, assessmentPayload]);

    // 5. Evaluate Anomalies
    const hrThresholdSetting = await db.get("SELECT value FROM settings WHERE key = 'heart_rate_threshold'");
    const stressThresholdSetting = await db.get("SELECT value FROM settings WHERE key = 'stress_threshold'");

    const hrThreshold = parseInt(hrThresholdSetting ? hrThresholdSetting.value : '100');
    const stressThreshold = parseInt(stressThresholdSetting ? stressThresholdSetting.value : '7');

    const anomalies = [];
    if (heartRate > hrThreshold) {
      const severity = heartRate > (hrThreshold + 25) ? 'critical' : 'moderate';
      await db.run(`
        INSERT INTO anomaly_logs (session_id, user_id, metric, value, severity)
        VALUES (?, ?, 'heart_rate', ?, ?)
      `, [sessionId, userId, heartRate, severity]);
      anomalies.push({ metric: 'heart_rate', value: heartRate, severity });
    }

    if (stressLevel > stressThreshold) {
      const severity = stressLevel >= 9 ? 'critical' : 'moderate';
      await db.run(`
        INSERT INTO anomaly_logs (session_id, user_id, metric, value, severity)
        VALUES (?, ?, 'stress_level', ?, ?)
      `, [sessionId, userId, stressLevel, severity]);
      anomalies.push({ metric: 'stress_level', value: stressLevel, severity });
    }

    // 6. Send summary card to Telegram if connected
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    if (user.telegram_chat_id && telegramBotToken && telegramBotToken !== 'your_token_here') {
      sendTelegramSummaryCard(telegramBotToken, user.telegram_chat_id, {
        heartRate,
        sleepHours,
        waterMl,
        stressLevel,
        fatigueScore: fatigueScore || 0,
        steps: steps || 0,
        activeMinutes: activeMinutes || 0,
        nudge: aiResult.nudge,
        assessment: aiResult.assessment,
        insights: aiResult.insights
      });
    }

    res.status(201).json({
      message: 'Session stored and analyzed successfully',
      sessionId,
      nudge: aiResult.nudge,
      assessment: aiResult.assessment,
      insights: aiResult.insights,
      hobbyTargeted: aiResult.targetHobby,
      anomalies
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/history', authenticateToken, async (req, res) => {
  try {
    // Get last 15 sessions for the chart
    const sessions = await db.all(`
      SELECT s.*, n.nudge_text, n.hobby_targeted, n.assessment_text 
      FROM sessions s
      LEFT JOIN ai_nudges n ON s.id = n.session_id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC
      LIMIT 15
    `, [req.user.id]);
    res.json(sessions.reverse()); // return in chronological order
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ADMIN API ---

app.get('/api/admin/anomalies', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const logs = await db.all(`
      SELECT a.*, u.email 
      FROM anomaly_logs a
      JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC
      LIMIT 50
    `);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM settings');
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
  const { heart_rate_threshold, stress_threshold, ai_temperature } = req.body;
  try {
    if (heart_rate_threshold != null) {
      await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['heart_rate_threshold', String(heart_rate_threshold)]);
    }
    if (stress_threshold != null) {
      await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['stress_threshold', String(stress_threshold)]);
    }
    if (ai_temperature != null) {
      await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['ai_temperature', String(ai_temperature)]);
    }
    res.json({ message: 'Admin settings saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create HTTP Server & WebSocket Hub
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Active user streams storage: userId -> { email, socket, lastHeartRate, lastUpdate, status }
const activeUsers = new Map();
// Admin listeners socket list
const adminSockets = new Set();

function broadcastToAdmins(message) {
  const data = JSON.stringify(message);
  adminSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

function getActiveMatrix() {
  const matrix = [];
  activeUsers.forEach((value, key) => {
    matrix.push({
      userId: key,
      email: value.email,
      heartRate: value.lastHeartRate,
      status: value.status,
      lastUpdate: value.lastUpdate
    });
  });
  return matrix;
}

wss.on('connection', (ws) => {
  let authenticatedUser = null;

  ws.on('message', async (message) => {
    try {
      const parsed = JSON.parse(message);

      // 1. Authenticate connection
      if (parsed.type === 'auth') {
        const token = parsed.token;
        if (!token) return ws.close(4001, 'Unauthorized');

        jwt.verify(token, JWT_SECRET, async (err, decoded) => {
          if (err) return ws.close(4001, 'Invalid token');

          authenticatedUser = decoded;
          
          if (authenticatedUser.role === 'admin') {
            adminSockets.add(ws);
            // Send initial state to admin
            ws.send(JSON.stringify({
              type: 'matrix_init',
              matrix: getActiveMatrix()
            }));
          } else {
            activeUsers.set(authenticatedUser.id, {
              email: authenticatedUser.email,
              socket: ws,
              lastHeartRate: null,
              status: 'Connected',
              lastUpdate: new Date().toISOString()
            });

            // Notify admins of new connection
            broadcastToAdmins({
              type: 'user_connected',
              user: {
                userId: authenticatedUser.id,
                email: authenticatedUser.email,
                status: 'Connected',
                heartRate: null,
                lastUpdate: new Date().toISOString()
              }
            });
          }
        });
      }

      // 2. Stream biometrics
      else if (parsed.type === 'telemetry') {
        if (!authenticatedUser || authenticatedUser.role === 'admin') return;

        const { heartRate, status } = parsed;
        const userSession = activeUsers.get(authenticatedUser.id);
        if (userSession) {
          userSession.lastHeartRate = heartRate;
          userSession.status = status || 'Syncing Smartwatch';
          userSession.lastUpdate = new Date().toISOString();

          // Broadcast state update to admins
          broadcastToAdmins({
            type: 'user_telemetry',
            userId: authenticatedUser.id,
            email: authenticatedUser.email,
            heartRate,
            status: userSession.status,
            lastUpdate: userSession.lastUpdate
          });
        }
      }
    } catch (e) {
      console.error('WS parsing error:', e.message);
    }
  });

  ws.on('close', () => {
    if (authenticatedUser) {
      if (authenticatedUser.role === 'admin') {
        adminSockets.delete(ws);
      } else {
        activeUsers.delete(authenticatedUser.id);
        
        // Notify admins of disconnection
        broadcastToAdmins({
          type: 'user_disconnected',
          userId: authenticatedUser.id
        });
      }
    }
  });
});

// Fallback to SPA index.html for unknown client routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- TELEGRAM BOT UTILITIES ---
let telegramOffset = 0;

function startTelegramBotPolling(token) {
  console.log('Starting Telegram Bot Polling...');
  
  const poll = async () => {
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${telegramOffset}&timeout=10`;
      const res = await fetch(url);
      if (!res.ok) {
        setTimeout(poll, 10000);
        return;
      }
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          telegramOffset = update.update_id + 1;
          if (update.message) {
            await handleTelegramMessage(token, update.message);
          }
        }
      }
      setTimeout(poll, 1000);
    } catch (err) {
      console.error('Error polling Telegram updates:', err.message);
      setTimeout(poll, 10000);
    }
  };
  
  poll();
}

async function handleTelegramMessage(token, message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  
  if (text.startsWith('/start')) {
    const parts = text.split(' ');
    if (parts.length > 1) {
      const pinCandidate = parts[1].replace('-', '');
      await processTelegramLink(token, chatId, pinCandidate);
    } else {
      await sendTelegramTextMessage(token, chatId, "Welcome to BioSync Bot! 🩺\n\nTo link your Telegram account, please enter the 6-digit pin code shown on your Profile Page on the BioSync website.");
    }
  } else {
    const normalized = text.replace('-', '').replace(' ', '');
    if (/^\d{6}$/.test(normalized)) {
      await processTelegramLink(token, chatId, normalized);
    } else {
      await sendTelegramTextMessage(token, chatId, "I didn't recognize that command or PIN. Please enter the 6-digit pin from your BioSync Profile Page to link your account.");
    }
  }
}

async function processTelegramLink(token, chatId, pin) {
  try {
    const user = await db.get('SELECT * FROM users WHERE telegram_pin = ?', [pin]);
    if (user) {
      await db.run('UPDATE users SET telegram_chat_id = ?, telegram_pin = NULL WHERE id = ?', [String(chatId), user.id]);
      await sendTelegramTextMessage(token, chatId, `🎉 Success! Your Telegram account has been linked to BioSync (Email: ${user.email}).\n\nWhenever you submit a biometric session on the website, you will receive a summary card here!`);
      console.log(`Successfully linked Telegram chat ${chatId} to user ID ${user.id} (${user.email})`);
    } else {
      await sendTelegramTextMessage(token, chatId, "❌ Invalid or expired PIN. Please verify the PIN on your BioSync Profile Page and try again.");
    }
  } catch (err) {
    console.error('Error linking Telegram:', err.message);
    await sendTelegramTextMessage(token, chatId, "⚠️ An error occurred while linking your account. Please try again later.");
  }
}

async function sendTelegramTextMessage(token, chatId, text) {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
    });
  } catch (err) {
    console.error('Error sending Telegram text message:', err.message);
  }
}

async function sendTelegramSummaryCard(token, chatId, data) {
  const { heartRate, sleepHours, waterMl, stressLevel, fatigueScore, steps, activeMinutes, nudge, assessment, insights } = data;
  const cupsCount = Math.round(waterMl / 250);
  
  let html = `<b>🩺 BioSync Recovery Card 🩺</b>\n\n`;
  html += `<b>Daily Biometrics:</b>\n`;
  html += `• Heart Rate: <b>${heartRate} BPM</b>\n`;
  html += `• Sleep: <b>${sleepHours} hrs</b>\n`;
  html += `• Water Intake: <b>${cupsCount}/8 cups</b> (${waterMl} ml)\n`;
  html += `• Stress Level: <b>${stressLevel}/10</b>\n`;
  html += `• Fatigue Score: <b>${fatigueScore}%</b>\n`;
  html += `• Daily Steps: <b>${Number(steps).toLocaleString()}</b>\n`;
  html += `• Active Minutes: <b>${activeMinutes} mins</b>\n\n`;
  
  html += `<b>AI Smart Suggestion:</b>\n`;
  html += `<i>"${nudge}"</i>\n\n`;
  
  html += `<b>🔬 Physiological Assessment:</b>\n`;
  html += `${assessment}\n\n\n`;
  
  if (insights) {
    html += `<b>AI Analysis Insights:</b>\n\n`;
    if (insights.sleep) html += `• <b>Sleep:</b> ${insights.sleep}\n`;
    if (insights.hydration) html += `• <b>Hydration:</b> ${insights.hydration}\n`;
    if (insights.stress) html += `• <b>Stress:</b> ${insights.stress}\n`;
    if (insights.heartRate) html += `• <b>Heart Rate:</b> ${insights.heartRate}\n`;
    if (insights.fatigue) html += `• <b>Fatigue Scan:</b> ${insights.fatigue}\n`;
  }
  
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error('Error sending Telegram card:', err.message);
  }
}

server.listen(port, () => {
  console.log(`BioSync server listening on http://localhost:${port}`);
  
  // Start Telegram bot updates polling loop if token is available
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  if (telegramBotToken && telegramBotToken !== 'your_token_here') {
    startTelegramBotPolling(telegramBotToken);
  } else {
    console.log('TELEGRAM_BOT_TOKEN not found in .env. Telegram integration is disabled until token is provided.');
  }
});
