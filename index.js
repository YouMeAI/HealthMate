require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const scenarios = require('./scenarios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
    console.error('Ошибка: TELEGRAM_BOT_TOKEN отсутствует в переменных окружения.');
    process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

bot.use(session());

// === Подключение кнопок ===
bot.start((ctx) => {
    ctx.reply('Добро пожаловать! Выберите действие:', Markup.keyboard([
        ['📋 Помощь', '👤 Профиль'],
        ['📊 Анализ данных', '📂 Загрузить файлы']
    ]).resize());
});

bot.hears('📋 Помощь', scenarios.help);
bot.hears('👤 Профиль', scenarios.profile);
bot.hears('📊 Анализ данных', scenarios.analyze);
bot.command('upload', scenarios.upload);
bot.command('analyze', scenarios.analyze);
bot.hears('📂 Загрузить файлы', scenarios.upload);

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

        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            telegram_id TEXT,
            file_id TEXT,
            file_name TEXT,
            file_type TEXT,
            file_content TEXT,
            analysis_data TEXT,
            uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
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
    },
    saveFile: async (fileData) => {
        const { user_id, telegram_id, file_id, file_name, file_type, file_content, analysis_data } = fileData;
        await db.run(`
            INSERT INTO files (user_id, telegram_id, file_id, file_name, file_type, file_content, analysis_data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [user_id, telegram_id, file_id, file_name, file_type, file_content, analysis_data]);
    },
    getUserFilesByTelegramId: async (telegramId) => {
        return db.all('SELECT * FROM files WHERE telegram_id = ?', [telegramId]);
    },
};

// === scenarios.js ===
module.exports = {
    help: (ctx) => {
        ctx.reply('Список команд:\n/help - помощь\n/profile - профиль\n/analyze - анализ данных\n/upload - загрузить файлы.');
    },

    profile: async (ctx) => {
        const telegramId = ctx.from.id;
        const profile = await db.getUserByTelegramId(telegramId);

        if (profile) {
            ctx.reply(`Ваш профиль:\nВозраст: ${profile.age || 'не указан'}\nПол: ${profile.gender || 'не указан'}\nРост: ${profile.height || 'не указан'} см\nВес: ${profile.weight || 'не указан'} кг\n\nЧтобы обновить данные, отправьте их в формате: возраст, пол, рост, вес.`);
        } else {
            ctx.reply('Ваш профиль не найден. Пожалуйста, используйте /start для создания профиля.');
        }
    },

    analyze: async (ctx) => {
        const telegramId = ctx.from.id;
        try {
            const userData = await db.getUserByTelegramId(telegramId);

            if (!userData) {
                ctx.reply('Пожалуйста, создайте профиль с помощью команды /profile перед анализом данных.');
                return;
            }

            const userFiles = await db.getUserFilesByTelegramId(telegramId);

            if (!userFiles || userFiles.length === 0) {
                ctx.reply('У вас нет загруженных файлов для анализа. Используйте команду /upload, чтобы загрузить данные.');
                return;
            }

            ctx.reply('Пожалуйста, подождите. Ваши данные анализируются...');

            const analysisText = `Профиль пользователя:\nВозраст: ${userData.age || 'не указан'}\nПол: ${userData.gender || 'не указан'}\nРост: ${userData.height || 'не указан'} см\nВес: ${userData.weight || 'не указан'} кг\n`;

            const report = await gpt4.generateReport({ userData, userFiles });

            if (report.error) {
                ctx.reply(`Не удалось завершить анализ данных. Причина: ${report.message}`);
                return;
            }

            ctx.reply(`Анализ завершён. Ваш отчёт:\n\n${report.text}`);

        } catch (error) {
            console.error('Ошибка анализа данных:', error);
            ctx.reply('Произошла ошибка при анализе данных. Попробуйте позже.');
        }
    },

    upload: async (ctx) => {
        ctx.reply('Пожалуйста, загрузите свои файлы для анализа.');
    },

    textHandler: async (ctx) => {
        ctx.reply('Вы отправили текст.');
    },

    fileHandler: async (ctx) => {
        ctx.reply('Файл получен.');
    }
};
