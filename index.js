require('dotenv').config();
const { Telegraf } = require('telegraf'); // Telegram API
const { OpenAI } = require('openai'); // OpenAI API
const axios = require('axios'); // Загрузка файлов
const fs = require('fs'); // Файлы
const sharp = require('sharp'); // Обработка изображений
const { fromPath } = require('pdf2pic'); // Конвертация PDF в изображения
const sqlite3 = require('sqlite3').verbose(); // База данных SQLite
const { open } = require('sqlite'); // Подключение к базе данных

// Подключаем токены из переменных окружения
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const DATABASE_PATH = process.env.DATABASE_PATH || './database.db';

if (!TELEGRAM_BOT_TOKEN || !OPENAI_API_KEY) {
  console.error('Ошибка: Отсутствуют обязательные переменные окружения TELEGRAM_BOT_TOKEN или OPENAI_API_KEY.');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// === База данных ===
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

// === Авторизация и создание профиля ===
bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  const username = ctx.from.username || 'unknown';

  const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);

  if (!user) {
    await db.run('INSERT INTO users (telegram_id, username) VALUES (?, ?)', [telegramId, username]);
    ctx.reply('Профиль создан! Теперь вы можете загружать файлы и использовать анализ AI.');
  } else {
    ctx.reply('С возвращением! Вы уже авторизованы. Загружайте файлы или задавайте вопросы.');
  }
});

// === Обработка текстовых сообщений ===
bot.on('text', async (ctx) => {
  try {
    // Показываем индикатор набора текста (бегущие точки)
    await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');

    const telegramId = ctx.from.id;
    const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);

    if (ctx.message.text.toLowerCase().includes('сравнить')) {
      const files = await db.all('SELECT * FROM files WHERE user_id = ?', [user.id]);

      if (files.length < 2) {
        ctx.reply('Недостаточно данных для сравнения. Загрузите хотя бы два файла.');
        return;
      }

      const latestFile = files[files.length - 1];
      const previousFile = files[files.length - 2];

      const comparisonPrompt = `Сравни следующие данные анализов:

Последние данные:
${latestFile.content}

Предыдущие данные:
${previousFile.content}

Найди различия и укажи, в каких показателях произошли изменения. Отметь значительные изменения.`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: comparisonPrompt }
        ],
      });

      ctx.reply(response.choices[0].message.content);
    } else {
      ctx.reply('Напишите "сравнить", чтобы анализировать ваши данные.');
    }
  } catch (error) {
    console.error('Ошибка обработки текста:', error.message);
    ctx.reply('Произошла ошибка при обработке текста.');
  }
});

// === Обработка изображений и файлов ===
async function processFile(ctx, fileBuffer, fileName, fileType, extractedText) {
  try {
    const userId = await db.get('SELECT id FROM users WHERE telegram_id = ?', [ctx.from.id]);
    await db.run('INSERT INTO files (user_id, filename, filetype, content) VALUES (?, ?, ?, ?)', [userId.id, fileName, fileType, extractedText]);
    ctx.reply('Файл успешно обработан и сохранён.');
  } catch (error) {
    console.error('Ошибка сохранения файла в базу данных:', error.message);
    ctx.reply('Не удалось сохранить файл.');
  }
}

async function handleImage(ctx, responseBuffer) {
  try {
    const imageBuffer = await sharp(responseBuffer).toFormat('jpeg').toBuffer();
    const extractedText = 'Текст из изображения'; // Реализуйте извлечение текста, если требуется
    await processFile(ctx, imageBuffer, 'uploaded_image.jpg', 'image/jpeg', extractedText);
  } catch (error) {
    console.error('Ошибка обработки изображения:', error.message);
    ctx.reply('Не удалось обработать изображение.');
  }
}

async function handlePDF(ctx, responseBuffer) {
  try {
    const filePath = './file.pdf';
    fs.writeFileSync(filePath, responseBuffer);
    const converter = fromPath(filePath, {
      density: 300,
      saveFilename: 'converted_page',
      savePath: './',
      format: 'png',
    });

    const pages = await converter(1);
    const imageBuffer = fs.readFileSync(pages.path);
    const extractedText = 'Текст из PDF-файла'; // Реализуйте извлечение текста, если требуется
    await processFile(ctx, imageBuffer, 'converted_page.png', 'image/png', extractedText);
  } catch (error) {
    console.error('Ошибка обработки PDF:', error.message);
    ctx.reply('Не удалось обработать PDF-файл.');
  }
}

bot.on(['photo', 'document'], async (ctx) => {
  try {
    const file = ctx.message.photo?.pop() || ctx.message.document;
    const fileLink = await ctx.telegram.getFileLink(file.file_id);
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });

    if (file.mime_type === 'application/pdf') {
      await handlePDF(ctx, response.data);
    } else {
      await handleImage(ctx, response.data);
    }
  } catch (error) {
    console.error('Ошибка обработки файла:', error.message);
    ctx.reply('Не удалось обработать файл.');
  }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
