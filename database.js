// database.js - PostgreSQL version for Vercel
const { sql } = require('@vercel/postgres');
const bcrypt = require('bcryptjs');

// Helper functions for database operations
const run = async (query, params = []) => {
  try {
    const result = await sql.query(query, params);
    return { id: result.rows[0]?.id, changes: result.rowCount };
  } catch (err) {
    console.error('Run error:', err.message);
    throw err;
  }
};

const get = async (query, params = []) => {
  try {
    const result = await sql.query(query, params);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Get error:', err.message);
    throw err;
  }
};

const all = async (query, params = []) => {
  try {
    const result = await sql.query(query, params);
    return result.rows;
  } catch (err) {
    console.error('All error:', err.message);
    throw err;
  }
};

// Initialize all tables
async function initializeDatabase() {
  try {
    // Create Users Table
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        wellness_goals TEXT DEFAULT '[]',
        hobbies TEXT DEFAULT '[]',
        onboarding_answers TEXT,
        telegram_chat_id TEXT,
        telegram_pin TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    console.log('✅ Users table ready');

    // Create Sessions Table
    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        heart_rate INTEGER NOT NULL,
        sleep_hours REAL NOT NULL,
        water_ml INTEGER NOT NULL,
        stress_level INTEGER NOT NULL,
        fatigue_blink_rate REAL NOT NULL,
        fatigue_score INTEGER NOT NULL,
        face_snapshot_url TEXT,
        steps INTEGER DEFAULT 0,
        active_minutes INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `;
    console.log('✅ Sessions table ready');

    // Create AI Nudges Table
    await sql`
      CREATE TABLE IF NOT EXISTS ai_nudges (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        nudge_text TEXT NOT NULL,
        hobby_targeted TEXT,
        assessment_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `;
    console.log('✅ AI Nudges table ready');

    // Create Anomaly Logs Table
    await sql`
      CREATE TABLE IF NOT EXISTS anomaly_logs (
        id SERIAL PRIMARY KEY,
        session_id INTEGER,
        user_id INTEGER NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        severity TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `;
    console.log('✅ Anomaly Logs table ready');

    // Create Settings Table
    await sql`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
    console.log('✅ Settings table ready');

    // Create Telegram Connections Table (for better Telegram integration)
    await sql`
      CREATE TABLE IF NOT EXISTS telegram_connections (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE NOT NULL,
        chat_id BIGINT NOT NULL,
        connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `;
    console.log('✅ Telegram Connections table ready');

    // Create Telegram PINs Table
    await sql`
      CREATE TABLE IF NOT EXISTS telegram_pins (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        pin TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `;
    console.log('✅ Telegram Pins table ready');

    // Create indexes for better performance
    await sql`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_ai_nudges_user_id ON ai_nudges(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_anomaly_logs_user_id ON anomaly_logs(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_telegram_pins_pin ON telegram_pins(pin)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_telegram_pins_expires_at ON telegram_pins(expires_at)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_telegram_connections_user_id ON telegram_connections(user_id)`;
    console.log('✅ All indexes created');

    // Insert Default Settings if not present
    await sql`
      INSERT INTO settings (key, value) 
      VALUES ('heart_rate_threshold', '100')
      ON CONFLICT (key) DO NOTHING
    `;
    await sql`
      INSERT INTO settings (key, value) 
      VALUES ('stress_threshold', '7')
      ON CONFLICT (key) DO NOTHING
    `;
    await sql`
      INSERT INTO settings (key, value) 
      VALUES ('ai_temperature', '0.7')
      ON CONFLICT (key) DO NOTHING
    `;
    console.log('✅ Default settings inserted');

    // Seed default admin account: admin@biosync.com / admin123
    const existingAdmin = await get('SELECT * FROM users WHERE email = $1', ['admin@biosync.com']);
    if (!existingAdmin) {
      const hash = await bcrypt.hash('admin123', 10);
      await sql`
        INSERT INTO users (email, password_hash, role, wellness_goals, hobbies) 
        VALUES ('admin@biosync.com', ${hash}, 'admin', '["maintain", "focus"]', '["coding", "guitar"]')
      `;
      console.log('✅ Seeded default admin user: admin@biosync.com / admin123');
    }

    console.log('🎉 Database initialization complete!');
  } catch (err) {
    console.error('Error during database initialization:', err.message);
    throw err;
  }
}

// ========== USER FUNCTIONS ==========

async function createUser(email, passwordHash, wellnessGoals = '[]', hobbies = '[]') {
  const result = await sql`
    INSERT INTO users (email, password_hash, wellness_goals, hobbies)
    VALUES (${email}, ${passwordHash}, ${wellnessGoals}, ${hobbies})
    RETURNING id, email, role, wellness_goals, hobbies, created_at
  `;
  return result.rows[0];
}

async function getUserByEmail(email) {
  return await get('SELECT * FROM users WHERE email = $1', [email]);
}

async function getUserById(id) {
  return await get('SELECT * FROM users WHERE id = $1', [id]);
}

async function updateUserTelegramChatId(userId, chatId) {
  await sql`
    UPDATE users 
    SET telegram_chat_id = ${chatId}
    WHERE id = ${userId}
  `;
}

async function updateUserTelegramPin(userId, pin) {
  await sql`
    UPDATE users 
    SET telegram_pin = ${pin}
    WHERE id = ${userId}
  `;
}

async function getUserByTelegramPin(pin) {
  return await get('SELECT * FROM users WHERE telegram_pin = $1', [pin]);
}

// ========== SESSION FUNCTIONS ==========

async function saveSession(sessionData) {
  const { user_id, heart_rate, sleep_hours, water_ml, stress_level, 
          fatigue_blink_rate, fatigue_score, face_snapshot_url, steps, active_minutes } = sessionData;
  
  const result = await sql`
    INSERT INTO sessions (
      user_id, heart_rate, sleep_hours, water_ml, stress_level,
      fatigue_blink_rate, fatigue_score, face_snapshot_url, steps, active_minutes
    ) VALUES (
      ${user_id}, ${heart_rate}, ${sleep_hours}, ${water_ml}, ${stress_level},
      ${fatigue_blink_rate}, ${fatigue_score}, ${face_snapshot_url}, ${steps}, ${active_minutes}
    )
    RETURNING id
  `;
  return result.rows[0];
}

async function getUserSessions(userId, limit = 20) {
  return await all(`
    SELECT * FROM sessions 
    WHERE user_id = $1 
    ORDER BY created_at DESC 
    LIMIT $2
  `, [userId, limit]);
}

async function getSessionById(sessionId) {
  return await get('SELECT * FROM sessions WHERE id = $1', [sessionId]);
}

// ========== AI NUDGE FUNCTIONS ==========

async function saveAiNudge(nudgeData) {
  const { session_id, user_id, nudge_text, hobby_targeted, assessment_text } = nudgeData;
  
  const result = await sql`
    INSERT INTO ai_nudges (session_id, user_id, nudge_text, hobby_targeted, assessment_text)
    VALUES (${session_id}, ${user_id}, ${nudge_text}, ${hobby_targeted}, ${assessment_text})
    RETURNING id
  `;
  return result.rows[0];
}

async function getAiNudgesByUser(userId, limit = 20) {
  return await all(`
    SELECT * FROM ai_nudges 
    WHERE user_id = $1 
    ORDER BY created_at DESC 
    LIMIT $2
  `, [userId, limit]);
}

// ========== ANOMALY LOG FUNCTIONS ==========

async function saveAnomalyLog(anomalyData) {
  const { session_id, user_id, metric, value, severity } = anomalyData;
  
  await sql`
    INSERT INTO anomaly_logs (session_id, user_id, metric, value, severity)
    VALUES (${session_id}, ${user_id}, ${metric}, ${value}, ${severity})
  `;
}

async function getAnomalyLogs(userId, limit = 50) {
  return await all(`
    SELECT * FROM anomaly_logs 
    WHERE user_id = $1 
    ORDER BY created_at DESC 
    LIMIT $2
  `, [userId, limit]);
}

// ========== SETTINGS FUNCTIONS ==========

async function getSetting(key) {
  const result = await get('SELECT value FROM settings WHERE key = $1', [key]);
  return result?.value;
}

async function setSetting(key, value) {
  await sql`
    INSERT INTO settings (key, value)
    VALUES (${key}, ${value})
    ON CONFLICT (key) 
    DO UPDATE SET value = ${value}
  `;
}

// ========== TELEGRAM FUNCTIONS ==========

async function saveTelegramConnection(userId, chatId) {
  await sql`
    INSERT INTO telegram_connections (user_id, chat_id)
    VALUES (${userId}, ${chatId})
    ON CONFLICT (user_id) 
    DO UPDATE SET chat_id = ${chatId}, connected_at = CURRENT_TIMESTAMP
  `;
}

async function getTelegramChatId(userId) {
  const result = await get('SELECT chat_id FROM telegram_connections WHERE user_id = $1', [userId]);
  return result?.chat_id || null;
}

async function removeTelegramConnection(userId) {
  await sql`DELETE FROM telegram_connections WHERE user_id = ${userId}`;
}

async function createTelegramPin(userId, pin, expiresAt) {
  await sql`
    INSERT INTO telegram_pins (user_id, pin, expires_at)
    VALUES (${userId}, ${pin}, ${expiresAt})
  `;
}

async function verifyTelegramPin(pin) {
  const result = await get(`
    SELECT user_id FROM telegram_pins 
    WHERE pin = $1 AND expires_at > CURRENT_TIMESTAMP
    ORDER BY created_at DESC 
    LIMIT 1
  `, [pin]);
  return result?.user_id || null;
}

async function deleteTelegramPin(pin) {
  await sql`DELETE FROM telegram_pins WHERE pin = ${pin}`;
}

// ========== STATS FUNCTIONS ==========

async function getUserStats(userId) {
  const stats = await get(`
    SELECT 
      COUNT(*) as total_sessions,
      AVG(heart_rate) as avg_heart_rate,
      AVG(sleep_hours) as avg_sleep,
      AVG(water_ml) as avg_water,
      AVG(stress_level) as avg_stress,
      AVG(fatigue_score) as avg_fatigue,
      SUM(steps) as total_steps
    FROM sessions 
    WHERE user_id = $1
  `, [userId]);
  return stats;
}

// ========== ADMIN FUNCTIONS ==========

async function getAllUsers(limit = 100) {
  return await all(`
    SELECT id, email, role, created_at 
    FROM users 
    ORDER BY created_at DESC 
    LIMIT $1
  `, [limit]);
}

async function getAllAnomalies(limit = 100) {
  return await all(`
    SELECT a.*, u.email 
    FROM anomaly_logs a
    JOIN users u ON a.user_id = u.id
    ORDER BY a.created_at DESC 
    LIMIT $1
  `, [limit]);
}

// Export all functions
module.exports = {
  // Core DB functions
  db: { query: sql },
  run,
  get,
  all,
  initializeDatabase,
  
  // User functions
  createUser,
  getUserByEmail,
  getUserById,
  updateUserTelegramChatId,
  updateUserTelegramPin,
  getUserByTelegramPin,
  
  // Session functions
  saveSession,
  getUserSessions,
  getSessionById,
  
  // AI Nudge functions
  saveAiNudge,
  getAiNudgesByUser,
  
  // Anomaly functions
  saveAnomalyLog,
  getAnomalyLogs,
  
  // Settings functions
  getSetting,
  setSetting,
  
  // Telegram functions
  saveTelegramConnection,
  getTelegramChatId,
  removeTelegramConnection,
  createTelegramPin,
  verifyTelegramPin,
  deleteTelegramPin,
  
  // Stats functions
  getUserStats,
  
  // Admin functions
  getAllUsers,
  getAllAnomalies
};