// === bot.js ===
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const scenarios = require('./scenarios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
    console.error('Ошибка: TELEGRAM_BOT_TOKEN отсутствует в переменных окружения.');
    process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// === Подключение кнопок ===
bot.start((ctx) => {
    ctx.reply('Добро пожаловать! Выберите действие:', Markup.keyboard([
        ['📋 Помощь', '👤 Профиль'],
        ['📊 Анализ данных']
    ]).resize());
});

bot.hears('📋 Помощь', scenarios.help);
bot.hears('👤 Профиль', scenarios.profile);
bot.hears('📊 Анализ данных', scenarios.analyze);

bot.on('text', scenarios.textHandler);
bot.on(['photo', 'document'], scenarios.fileHandler);

bot.launch();
console.log('Бот запущен с кнопками!');

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
// Удалён повторный импорт 'db'

module.exports = {
    help: (ctx) => {
        ctx.reply(`Доступные команды:\n/start - Начать работу\n/help - Список команд\n/profile - Просмотр и редактирование профиля\n/analyze - Отправка данных для анализа`);
    },

    profile: async (ctx) => {
        const telegramId = ctx.from.id;
        const profile = await db.getUserProfile(telegramId);

        if (profile) {
            ctx.reply(`Ваш профиль:\nВозраст: ${profile.age || 'не указан'}\nПол: ${profile.gender || 'не указан'}\nРост: ${profile.height || 'не указан'} см\nВес: ${profile.weight || 'не указан'} кг\n\nЧтобы обновить данные, отправьте их в формате: возраст, пол, рост, вес.`);
        } else {
            ctx.reply('Ваш профиль не найден. Пожалуйста, используйте /start для создания профиля.');
        }
    },

    analyze: (ctx) => {
        ctx.reply('Отправьте текст, изображение или PDF для анализа.');
    },

    textHandler: async (ctx) => {
        ctx.reply('Обработка текстовых сообщений временно недоступна.');
    },

    fileHandler: async (ctx) => {
        ctx.reply('Обработка файлов временно недоступна.');
    }
};
