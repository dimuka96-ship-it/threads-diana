// Контент-движок: собирает брифы из контент-банка и генерирует очередь постов.
// Ниша «Поверни себе собі» (Діана Паланська). Главная ось разнообразия — formats.js
// (100 форматов), плюс тема × сегмент × голос × форма × хук. Анти-повтор внутри пачки
// и между запусками (data/history.json), опора на инсайты (data/insights.json).
//
// Запуск:
//   node --env-file=.env src/generate.js --count 24
//   node --env-file=.env src/generate.js --count 5 --no-ai   # скелеты без LLM

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pillars, offers, niches, rotation } from "./content/pillars.js";
import { formats, formatFamilies } from "./content/formats.js";
import { hookFormulas } from "./content/hooks.js";
import { lengthProfiles } from "./content/archetypes.js";
import { conversationalCtas } from "./content/cta.js";
import { subtopics, voices, shapes } from "./content/dimensions.js";
import { generatePost, aiAvailable } from "./llm.js";
import { pickMedia } from "./vision.js";
import { saveToMedia } from "./drive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "data");
const HISTORY_FILE = join(DATA, "history.json");
const INSIGHTS_FILE = join(DATA, "insights.json");
const RECENTS_FILE = join(DATA, "recent.json");
const MEDIA_JSON = join(DATA, "media.json");
const HISTORY_KEEP = 80;
const RECENTS_KEEP = 16;

// Медиа: куда Threads ходит за фото/видео (raw из публичного репо). В Actions берём из GITHUB_REPOSITORY.
const RAW_BASE = process.env.MEDIA_BASE_URL ||
  `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY || "dimuka96-ship-it/threads-diana"}/main/data/media`;
const MEDIA_ENABLED = process.env.MEDIA_ENABLED !== "0";
// Частота медиа: каждый N-й пост получает фото/видео. 6 = каждый 6-й (~4 раза/сутки при ежечасном постинге).
const MEDIA_EVERY = Number(process.env.MEDIA_EVERY || 6);

const EXT = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "video/quicktime": "mov", "video/mp4": "mp4" };
const extFor = (m) => EXT[m.mimeType] || (m.name.split(".").pop() || "bin").toLowerCase();

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function pickWeighted(items) {
  const total = items.reduce((s, i) => s + (i.weight || 1), 0);
  let r = Math.random() * total;
  for (const i of items) {
    r -= i.weight || 1;
    if (r <= 0) return i;
  }
  return items[items.length - 1];
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

// --- расписание: постим КАЖДЫЙ ЧАС, круглосуточно (UTC-слоты) ---
const POST_SLOTS = [
  "00:00", "01:00", "02:00", "03:00", "04:00", "05:00",
  "06:00", "07:00", "08:00", "09:00", "10:00", "11:00",
  "12:00", "13:00", "14:00", "15:00", "16:00", "17:00",
  "18:00", "19:00", "20:00", "21:00", "22:00", "23:00",
];
const POSTS_PER_DAY = POST_SLOTS.length;

function buildSchedule(count) {
  const times = [];
  const start = new Date();
  let day = 0;
  let idx = 0;
  while (times.length < count) {
    const [h, m] = POST_SLOTS[idx % POSTS_PER_DAY].split(":").map(Number);
    const d = new Date(start);
    d.setDate(start.getDate() + day);
    d.setHours(h, m, 0, 0);
    if (d > start) times.push(d.toISOString());
    idx++;
    if (idx % POSTS_PER_DAY === 0) { day++; idx = 0; }
  }
  return times;
}

// --- подбор инсайта под бриф (опора на реальный ресёрч) ---
function pickInsight(insights, themeId, segment) {
  if (!insights || insights.length === 0) return null;
  const tagged = insights.filter(
    (i) => Array.isArray(i.tags) && i.tags.some((t) => t === themeId || segment.includes(t) || themeId.includes(t)),
  );
  const chosen = tagged.length ? pick(tagged) : pick(insights);
  const facts = Array.isArray(chosen.facts) ? chosen.facts.join("; ") : "";
  return [chosen.topic, facts, chosen.example ? `Приклад: ${chosen.example}` : ""].filter(Boolean).join(". ");
}

// --- сборка брифа с анти-повтором (по теме, формату и СЕМЕЙСТВУ формата) ---
function buildBrief(seen, history, insights, category) {
  const pool = category ? pillars.filter((p) => p.category === category) : pillars;
  const themePool = pool.length ? pool : pillars;
  let theme, format, segment, subtopic, signature;
  for (let attempt = 0; attempt < 40; attempt++) {
    theme = pickWeighted(themePool);
    format = pickWeighted(formats);
    segment = pick(niches);
    subtopic = pick(subtopics);
    signature = `${theme.id}|${format.id}|${segment}`;
    // не повторяем в этой пачке: семейство формата, сегмент, подтему; и сигнатуру недавно
    if (
      !seen.has("fam:" + format.family) &&
      !seen.has("seg:" + segment) &&
      !seen.has("sub:" + subtopic) &&
      !seen.has(signature) &&
      !history.has(signature)
    ) break;
  }
  seen.add(signature);
  seen.add("fam:" + format.family);
  seen.add("seg:" + segment);
  seen.add("sub:" + subtopic);

  const hook = pick(hookFormulas);
  const voice = pick(voices);
  const shape = pick(shapes);
  const lengthHint = pick(Object.values(lengthProfiles));
  const insight = insights && Math.random() < 0.4 ? pickInsight(insights, theme.id, segment) : null;

  return {
    signature,
    themeId: theme.id,
    themeTitle: theme.title,
    angle: theme.angle,
    formatId: format.id,
    formatName: format.id,
    formatFamily: format.family,
    formatRecipe: format.recipe,
    segment,
    subtopic,
    voice,
    shape,
    hookId: hook.id,
    hookPattern: hook.pattern,
    lengthHint,
    ctaHint: pick(conversationalCtas),
    offerText: offers.course,
    insight,
  };
}

function skeleton(brief) {
  const post = [
    `[ФОРМАТ ${brief.formatId}] ${brief.formatRecipe}`,
    `Тема: ${brief.themeTitle} | Для кого: ${brief.segment}`,
    `Підтема: ${brief.subtopic}`,
    brief.insight ? `Інсайт: ${brief.insight}` : "",
    `[Питання] ${brief.ctaHint}`,
  ].filter(Boolean).join("\n");
  return { post, char_count: post.length, needs_image: false, image_idea: "", hashtags: [] };
}

async function main() {
  const args = process.argv.slice(2);
  const count = Number(args[args.indexOf("--count") + 1]) || 5;
  const noAi = args.includes("--no-ai");
  const useAi = !noAi && aiAvailable();
  if (!noAi && !aiAvailable()) {
    console.log("⚠️  GEMINI_API_KEY не задан — генерирую скелеты.");
  }

  const insights = await loadJson(INSIGHTS_FILE, null);
  if (insights && insights.length) console.log(`📚 Загружено инсайтов: ${insights.length}`);
  const historyArr = await loadJson(HISTORY_FILE, []);
  const history = new Set(historyArr.slice(-HISTORY_KEEP));
  const recents = (await loadJson(RECENTS_FILE, [])).slice(-RECENTS_KEEP);
  const mediaManifest = await loadJson(MEDIA_JSON, { items: {} });
  const hasMedia = MEDIA_ENABLED && Object.keys(mediaManifest.items || {}).length > 0;
  let mediaDirty = false;
  const seen = new Set();

  const useRotation = !args.includes("--no-rotate");

  const schedule = buildSchedule(count);
  const queue = [];

  for (let i = 0; i < count; i++) {
    const category = useRotation ? rotation[i % rotation.length] : null;
    const brief = buildBrief(seen, history, insights, category);
    let content;
    try {
      content = useAi ? await generatePost(brief, recents) : skeleton(brief);
      if (!content) content = skeleton(brief);
    } catch (e) {
      console.error(`Пост ${i + 1}: ошибка (${e.message}), пишу скелет.`);
      content = skeleton(brief);
    }
    if (content.char_count > 500) console.warn(`⚠️  Пост ${i + 1}: ${content.char_count} символов (>500) — нужна правка.`);
    recents.push(content.post);

    // Медиа раз в 1-2 поста: подбор по тегам (в коде, без ИИ) + скачивание из Drive в репо.
    let media = {};
    if (hasMedia && useAi && i % MEDIA_EVERY === 0) {
      try {
        const videoOk = Math.floor(i / MEDIA_EVERY) % 2 === 1; // чередуем: часть медиа-постов — видео
        // НИКОГДА не повторяем медиа: берём только неиспользованное. Кончились — пост без медиа.
        const chosen = pickMedia(mediaManifest, brief, { videoOk });
        if (!chosen) {
          console.log(`  ℹ️ свободных медиа не осталось — пост ${i + 1} без фото (повторы запрещены).`);
        }
        if (chosen) {
          const safeName = `${chosen.id}.${extFor(chosen)}`;
          await saveToMedia(chosen.id, safeName);
          media = {
            media_type: chosen.mimeType.startsWith("video") ? "VIDEO" : "IMAGE",
            media_file: chosen.name,
            media_url: `${RAW_BASE}/${safeName}`,
            media_tags: chosen.tags || [],
          };
          mediaManifest.items[chosen.id].used = true;
          mediaDirty = true;
        }
      } catch (e) {
        console.warn(`  ⚠️ медиа к посту ${i + 1} не прикреплено: ${e.message}`);
      }
    }

    queue.push({
      id: `post-${Date.now()}-${i}`,
      status: "draft",
      scheduled_at: schedule[i],
      pillar: brief.themeId,
      format: brief.formatId,
      family: brief.formatFamily,
      segment: brief.segment,
      grounded: Boolean(brief.insight),
      ai_generated: useAi,
      ...content,
      ...media,
    });
    console.log(`✅ ${i + 1}/${count} [${brief.themeTitle} · ${brief.formatId} · ${brief.segment}]${media.media_url ? ` 📷${media.media_type}` : ""}${brief.insight ? " 📚" : ""}`);
  }

  await mkdir(DATA, { recursive: true });
  await writeFile(join(DATA, "queue.json"), JSON.stringify({ generated_at: new Date().toISOString(), count, posts: queue }, null, 2), "utf8");
  const newHistory = [...historyArr, ...[...seen].filter((s) => !s.includes(":"))].slice(-HISTORY_KEEP);
  await writeFile(HISTORY_FILE, JSON.stringify(newHistory, null, 2), "utf8");
  await writeFile(RECENTS_FILE, JSON.stringify(recents.slice(-RECENTS_KEEP), null, 2), "utf8");
  if (mediaDirty) await writeFile(MEDIA_JSON, JSON.stringify(mediaManifest, null, 2), "utf8");
  console.log(`\n📂 Очередь: data/queue.json · анти-повтор (${newHistory.length} сигнатур, ${recents.slice(-RECENTS_KEEP).length} текстов).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
