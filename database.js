const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, 'biosync.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database at:', dbPath);
    initializeDatabase();
  }
});

// Helper functions for promisified queries
const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

async function initializeDatabase() {
  try {
    // Create Users Table
    await run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        wellness_goals TEXT DEFAULT '[]',
        hobbies TEXT DEFAULT '[]',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create Sessions Table
    await run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    // Create AI Nudges Table
    await run(`
      CREATE TABLE IF NOT EXISTS ai_nudges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        nudge_text TEXT NOT NULL,
        hobby_targeted TEXT,
        assessment_text TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    // Create Anomaly Logs Table
    await run(`
      CREATE TABLE IF NOT EXISTS anomaly_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        user_id INTEGER NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        severity TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    

    // Create Settings Table
    await run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Database Migrations (Run safe alters for existing tables)
    await runSchemaMigrations();

    // Insert Default Settings if not present
    await run("INSERT OR IGNORE INTO settings (key, value) VALUES ('heart_rate_threshold', '100')");
    await run("INSERT OR IGNORE INTO settings (key, value) VALUES ('stress_threshold', '7')");
    await run("INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_temperature', '0.7')");

    // Seed default admin account: admin@biosync.com / admin123
    const adminEmail = 'admin@biosync.com';
    const existingAdmin = await get('SELECT * FROM users WHERE email = ?', [adminEmail]);
    if (!existingAdmin) {
      const hash = await bcrypt.hash('admin123', 10);
      await run(`
        INSERT INTO users (email, password_hash, role, wellness_goals, hobbies) 
        VALUES (?, ?, 'admin', '["maintain", "focus"]', '["coding", "guitar"]')
      `, [adminEmail, hash]);
      console.log('Seeded default admin user: admin@biosync.com / admin123');
    }

  } catch (err) {
    console.error('Error during database initialization:', err.message);
  }
}

// Function to safely execute alterations for schema migrations
async function runSchemaMigrations() {
  try {
    // 1. Check if 'steps' column exists in 'sessions'
    const sessionCols = await all("PRAGMA table_info(sessions)");
    const hasSteps = sessionCols.some(col => col.name === 'steps');
    if (!hasSteps) {
      await run("ALTER TABLE sessions ADD COLUMN steps INTEGER DEFAULT 0");
      console.log("Migration: Added column 'steps' to table 'sessions'");
    }

    const hasActiveMinutes = sessionCols.some(col => col.name === 'active_minutes');
    if (!hasActiveMinutes) {
      await run("ALTER TABLE sessions ADD COLUMN active_minutes INTEGER DEFAULT 0");
      console.log("Migration: Added column 'active_minutes' to table 'sessions'");
    }

    const hasEyeStrain = sessionCols.some(col => col.name === 'eye_strain');
    if (!hasEyeStrain) {
      await run("ALTER TABLE sessions ADD COLUMN eye_strain INTEGER DEFAULT 0");
      console.log("Migration: Added column 'eye_strain' to table 'sessions'");
    }

    // 2. Check if 'assessment_text' exists in 'ai_nudges'
    const nudgeCols = await all("PRAGMA table_info(ai_nudges)");
    const hasAssessment = nudgeCols.some(col => col.name === 'assessment_text');
    if (!hasAssessment) {
      await run("ALTER TABLE ai_nudges ADD COLUMN assessment_text TEXT");
      console.log("Migration: Added column 'assessment_text' to table 'ai_nudges'");
    }

    // 3. Check and add columns to 'users' table
    const userCols = await all("PRAGMA table_info(users)");
    const hasOnboarding = userCols.some(col => col.name === 'onboarding_answers');
    if (!hasOnboarding) {
      await run("ALTER TABLE users ADD COLUMN onboarding_answers TEXT");
      console.log("Migration: Added column 'onboarding_answers' to table 'users'");
    }
    const hasTelegramChatId = userCols.some(col => col.name === 'telegram_chat_id');
    if (!hasTelegramChatId) {
      await run("ALTER TABLE users ADD COLUMN telegram_chat_id TEXT");
      console.log("Migration: Added column 'telegram_chat_id' to table 'users'");
    }
    const hasTelegramPin = userCols.some(col => col.name === 'telegram_pin');
    if (!hasTelegramPin) {
      await run("ALTER TABLE users ADD COLUMN telegram_pin TEXT");
      console.log("Migration: Added column 'telegram_pin' to table 'users'");
    }
  } catch (e) {
    console.error("Database migration failed:", e.message);
  }
}

module.exports = {
  db,
  run,
  get,
  all
};
