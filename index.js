// === bot.js ===
require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./database');
const { handleFile } = require('./fileHandler');
const { analyzeAndCompare } = require('./analyze');

// Telegram Bot Setup
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
    console.error('Ошибка: TELEGRAM_BOT_TOKEN отсутствует в переменных окружения.');
    process.exit(1);
}
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Start Command
bot.start(async (ctx) => {
    const telegramId = ctx.from.id;
    const username = ctx.from.username || 'unknown';

    const user = await db.getUserByTelegramId(telegramId);
    if (!user) {
        await db.createUser(telegramId, username);
        ctx.reply('Профиль создан! Теперь вы можете загружать файлы и использовать анализ AI.');
    } else {
        ctx.reply('С возвращением! Вы уже авторизованы. Загружайте файлы или задавайте вопросы.');
    }
});

// Text Message Handling
bot.on('text', async (ctx) => {
    try {
        await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
        await analyzeAndCompare(ctx, ctx.message.text);
    } catch (error) {
        console.error('Ошибка обработки текста:', error.message);
        ctx.reply('Произошла ошибка при обработке текста.');
    }
});

// File Handling
bot.on(['photo', 'document'], async (ctx) => {
    try {
        await handleFile(ctx);
    } catch (error) {
        console.error('Ошибка обработки файла:', error.message);
        ctx.reply('Не удалось обработать файл.');
    }
});

// Launch the bot
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
        driver: sqlite3.Database,
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            telegram_id TEXT UNIQUE,
            username TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY,
            user_id INTEGER,
            filename TEXT,
            filetype TEXT,
            content TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
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
    saveFile: async (userId, filename, filetype, content) => {
        await db.run('INSERT INTO files (user_id, filename, filetype, content) VALUES (?, ?, ?, ?)', [
            userId,
            filename,
            filetype,
            content,
        ]);
    },
};


// === fileHandler.js ===
const axios = require('axios');
const db = require('./database');
const { analyzeAndCompare } = require('./analyze');

async function handleFile(ctx) {
    const file = ctx.message.photo?.pop() || ctx.message.document;
    if (!file) {
        ctx.reply('Ошибка: файл не найден.');
        return;
    }

    const fileLink = await ctx.telegram.getFileLink(file.file_id);
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });

    const fileType = file.mime_type || 'unknown';

    if (fileType.startsWith('image/')) {
        await processImage(ctx, response.data);
    } else if (fileType === 'application/pdf') {
        await processPDF(ctx, response.data);
    } else {
        ctx.reply('Извините, но я пока не поддерживаю этот тип файла.');
    }
}

async function processImage(ctx, imageBuffer) {
    try {
        const response = await require('./analyze').sendToGPT({
            role: 'user',
            content: 'Это изображение анализа. Пожалуйста, извлеките текстовую информацию из этого изображения.',
            image: imageBuffer.toString('base64'), // Отправляем изображение в GPT как Base64
        });

        await analyzeAndCompare(ctx, response);
    } catch (error) {
        console.error('Ошибка обработки изображения через GPT:', error.message);
        ctx.reply('Не удалось обработать изображение.');
    }
}

async function processPDF(ctx, pdfBuffer) {
    try {
        const response = await require('./analyze').sendToGPT({
            role: 'user',
            content: 'Это PDF с данными анализа. Пожалуйста, извлеките текстовую информацию из этого документа.',
            file: pdfBuffer.toString('base64'), // Отправляем PDF как Base64
        });

        await analyzeAndCompare(ctx, response);
    } catch (error) {
        console.error('Ошибка обработки PDF через GPT:', error.message);
        ctx.reply('Не удалось обработать PDF.');
    }
}

module.exports = { handleFile };


// === analyze.js ===
const { OpenAIApi, Configuration } = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));

// Отправка данных в GPT
async function sendToGPT(prompt) {
    try {
        const response = await openai.createChatCompletion({
            model: 'gpt-4o-mini',
            messages: [prompt],
        });
        return response.data.choices[0].message.content.trim();
    } catch (error) {
        console.error('Ошибка взаимодействия с GPT:', error.message);
        throw error;
    }
}

async function analyzeAndCompare(ctx, newContent) {
    const telegramId = ctx.from.id;
    const user = await require('./database').getUserByTelegramId(telegramId);
    if (!user) {
        ctx.reply('Ошибка: Пользователь не найден. Пожалуйста, начните с команды /start.');
        return;
    }

    const previousFile = await require('./database').getUserByTelegramId(user.id);
    let comparisonResult = 'Это ваш первый загруженный анализ.';

    if (previousFile) {
        const comparisonPrompt = `Сравните данные:
Последние:
${newContent}
Предыдущие:
${previousFile.content}`;
        const response = await sendToGPT({ role: 'user', content: comparisonPrompt });
        comparisonResult = response;
    }

    ctx.reply(comparisonResult);
    await require('./database').saveFile(user.id, `analyze_${Date.now()}.txt`, 'text/plain', newContent);
}

module.exports = { analyzeAndCompare, sendToGPT };
