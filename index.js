require('dotenv').config();
const { Telegraf } = require('telegraf'); // Telegram API
const { OpenAI } = require('openai'); // OpenAI API
const axios = require('axios'); // Загрузка файлов
const fs = require('fs'); // Файлы
const sharp = require('sharp'); // Обработка изображений
const { fromPath } = require('pdf2pic'); // Конвертация PDF в изображения
const sqlite3 = require('sqlite3').verbose(); // База данных SQLite
const { open } = require('sqlite'); // Подключение к базе данных

// Подключаем токены
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const assistantId = process.env.ASSISTANT_ID;

// === База данных ===
let db;
(async () => {
  db = await open({
    filename: './database.db',
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
      const files = await db.all('SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC', [user.id]);

      console.log('Загруженные файлы:', files);

      if (files.length < 2) {
        ctx.reply('Недостаточно данных для сравнения. Загрузите хотя бы два файла.');
        return;
      }

      const latestFile = files[0];
      const previousFile = files[1];

      console.log('Последний файл:', latestFile);
      console.log('Предыдущий файл:', previousFile);

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
      const thread = await openai.beta.threads.create();
      await openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: ctx.message.text,
      });

      const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
      });

      let status = 'in_progress';
      let result;

      while (status === 'in_progress' || status === 'queued') {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        result = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        status = result.status;
      }

      const messages = await openai.beta.threads.messages.list(thread.id);
      const reply = messages.data[0].content[0].text.value;

      ctx.reply(reply);
    }
  } catch (error) {
    console.error('Ошибка обработки текста:', error.message);
    ctx.reply('Произошла ошибка при обработке текста.');
  }
});

// === Обработка изображений ===
async function processImage(ctx, imageBuffer, fileName, fileType, extractedText) {
  try {
    const userId = await db.get('SELECT id FROM users WHERE telegram_id = ?', [ctx.from.id]);
    await db.run('INSERT INTO files (user_id, filename, filetype, content) VALUES (?, ?, ?, ?)', [userId.id, fileName, fileType, extractedText]);

    console.log('Сохраняем данные:', extractedText);

    await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');

    const imageBase64 = imageBuffer.toString('base64');

    const visionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Опиши содержимое этого изображения и проанализируй его данные.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          ],
        },
      ],
    });

    ctx.reply(visionResponse.choices[0].message.content);
  } catch (error) {
    console.error('Ошибка обработки изображения:', error.message);
    ctx.reply('Не удалось обработать изображение.');
  }
}

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

