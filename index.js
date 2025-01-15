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
        ['📊 Анализ данных', '📂 Загрузить файлы'],
        ['🧠 Пройти стресс-тест']
    ]).resize());
});

bot.hears('📋 Помощь', scenarios.help);
bot.hears('👤 Профиль', scenarios.profile);
bot.hears('📊 Анализ данных', scenarios.analyze);
bot.command('upload', scenarios.upload);
bot.command('analyze', scenarios.analyze);
bot.hears('📂 Загрузить файлы', scenarios.upload);
bot.hears('🧠 Пройти стресс-тест', scenarios.stressTest);

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

        CREATE TABLE IF NOT EXISTS stress_tests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            telegram_id TEXT,
            question TEXT,
            answer INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
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
    saveStressTestResult: async (telegramId, question, answer) => {
        const user = await db.get('SELECT id FROM users WHERE telegram_id = ?', [telegramId]);
        if (user) {
            await db.run(`
                INSERT INTO stress_tests (user_id, telegram_id, question, answer)
                VALUES (?, ?, ?, ?)
            `, [user.id, telegramId, question, answer]);
        }
    },
    getStressTestResults: async (telegramId) => {
        return db.all('SELECT question, answer FROM stress_tests WHERE telegram_id = ?', [telegramId]);
    }
};

// === scenarios.js ===
module.exports = {
    help: (ctx) => {
        ctx.reply('Список команд:\n/help - помощь\n/profile - профиль\n/analyze - анализ данных\n/stresstest - пройти стресс-тест');
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

    stressTest: async (ctx) => {
        const telegramId = ctx.from.id;
        ctx.session.testProgress = 0;
        ctx.session.testResults = [];

        ctx.reply('Начинаем стресс-тест PSS-10. Ответьте на следующие вопросы, выбрав от 0 (никогда) до 4 (очень часто).');
        ctx.reply('Вопрос 1: Насколько часто вы чувствовали, что многое находится вне вашего контроля? (0-4)');
    },

    textHandler: async (ctx) => {
        const telegramId = ctx.from.id;
        const { testProgress, testResults } = ctx.session;

        if (testProgress !== undefined && testResults !== undefined) {
            const answer = parseInt(ctx.message.text, 10);

            if (isNaN(answer) || answer < 0 || answer > 4) {
                ctx.reply('Пожалуйста, введите число от 0 до 4.');
                return;
            }

            const questions = [
                'Насколько часто вы чувствовали, что многое находится вне вашего контроля?',
                'Как часто вы испытывали трудности в справлении с важными изменениями в жизни?',
                'Насколько часто вы чувствовали себя нервным или стрессованным?'
            ];

            testResults.push({ question: questions[testProgress], answer });
            ctx.session.testProgress += 1;

            if (ctx.session.testProgress < questions.length) {
                ctx.reply(`Вопрос ${ctx.session.testProgress + 1}: ${questions[ctx.session.testProgress]} (0-4)`);
            } else {
                ctx.session.testProgress = undefined;
                ctx.reply('Спасибо за прохождение теста! Результаты сохранены.');

                for (const result of testResults) {
                    await db.saveStressTestResult(telegramId, result.question, result.answer);
                }

                const totalScore = testResults.reduce((sum, item) => sum + item.answer, 0);
                let feedback;

                if (totalScore <= 13) {
                    feedback = 'Низкий уровень стресса. Продолжайте поддерживать баланс в жизни.';
                } else if (totalScore <= 26) {
                    feedback = 'Умеренный уровень стресса. Попробуйте добавить техники релаксации в вашу рутину.';
                } else {
                    feedback = 'Высокий уровень стресса. Рекомендуется проконсультироваться с профессионалом.';
                }

                ctx.reply(`Ваш итоговый результат: ${totalScore}\n${feedback}`);
            }
        } else {
            ctx.reply('Вы отправили текст.');
        }
    },

    fileHandler: async (ctx) => {
        ctx.reply('Файл получен.');
    }
};
