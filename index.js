// === bot.js ===
require('dotenv').config();
const { Telegraf } = require('telegraf');
const scenarios = require('./scenarios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
    console.error('Ошибка: TELEGRAM_BOT_TOKEN отсутствует в переменных окружения.');
    process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// === Подключение сценариев ===
bot.start(scenarios.start);
bot.command('help', scenarios.help);
bot.command('profile', scenarios.profile);
bot.command('analyze', scenarios.analyze);

bot.on('text', scenarios.textHandler);
bot.on(['photo', 'document'], scenarios.fileHandler);

bot.launch();
console.log('Бот запущен!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// === database.js ===
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const DATABASE_PATH = process.env.DATABASE_PATH || './database.db';

let db;
(async () => {
    db = await open({
        filename: DATABASE_PATH,
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            telegram_id TEXT UNIQUE,
            username TEXT,
            age INTEGER,
            gender TEXT,
            height REAL,
            weight REAL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
})();

module.exports = {
    getUserByTelegramId: async (telegramId) => {
        return db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
    },
    createUser: async (telegramId, username) => {
        await db.run('INSERT INTO users (telegram_id, username) VALUES (?, ?)', [telegramId, username]);
    },
    updateUserProfile: async (telegramId, profile) => {
        const { age, gender, height, weight } = profile;
        await db.run(`
            UPDATE users SET
            age = ?,
            gender = ?,
            height = ?,
            weight = ?
            WHERE telegram_id = ?
        `, [age, gender, height, weight, telegramId]);
    },
    getUserProfile: async (telegramId) => {
        return db.get('SELECT age, gender, height, weight FROM users WHERE telegram_id = ?', [telegramId]);
    }
};

// === scenarios.js ===
// Удалён дублирующий импорт переменной 'db'

module.exports = {
    start: async (ctx) => {
        const telegramId = ctx.from.id;
        const username = ctx.from.username || 'unknown';

        const user = await db.getUserByTelegramId(telegramId);

        if (!user) {
            await db.createUser(telegramId, username);
            ctx.reply('Привет! Ваш профиль создан. Используйте /help, чтобы узнать, что я могу.');
        } else {
            ctx.reply('С возвращением! Вы уже зарегистрированы.');
        }
    },

    help: (ctx) => {
        ctx.reply(`Доступные команды:
/start - Начать работу
/help - Список команд
/profile - Просмотр и редактирование профиля
/analyze - Отправка данных для анализа`);;;
    }
};
