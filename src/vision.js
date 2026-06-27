// ИИ-зрение через Gemini: смотрит превью каждого файла из FOTO и присваивает теги.
// ОПТИМИЗАЦИЯ ТОКЕНОВ:
//   • тегаем только НОВЫЕ файлы (кэш в data/media.json по fileId) — один раз навсегда;
//   • используем маленькое превью Drive (~512px), а не оригинал;
//   • БАТЧ: до BATCH_SIZE картинок в одном запросе → одна оплата на пачку;
//   • подбор медиа под пост потом считается В КОДЕ (см. pickMedia) — без обращений к ИИ.
//
// Запуск:
//   node --env-file=.env src/vision.js            # отегать все новые файлы
//   node --env-file=.env src/vision.js --limit 6  # только первые 6 новых (тест)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listMedia, getThumbnail } from "./drive.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEDIA_JSON = join(ROOT, "data", "media.json");
const MODEL = process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || "gemini-3.5-flash";
const BATCH_SIZE = Number(process.env.VISION_BATCH || 10);

// Контролируемый словарь тегов (укр.) — заточен под темы ниши, чтобы подбор был простым.
export const TAG_VOCAB = [
  "мама_з_дитиною", "вагітна", "жінка_сама", "портрет_обличчя", "природа",
  "море_пляж", "дім_затишок", "кава_сніданок", "йога_медитація", "втома_сум",
  "радість_світло", "краса_догляд", "пара_стосунки", "робота_ноутбук", "діти",
  "тіло_деталь", "квіти", "захід_сонця",
];

function apiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}
let ai = null;
async function getClient() {
  if (!apiKey()) throw new Error("нет GEMINI_API_KEY");
  if (!ai) {
    const { GoogleGenAI } = await import("@google/genai");
    ai = new GoogleGenAI({ apiKey: apiKey() });
  }
  return ai;
}

async function loadManifest() {
  try {
    return JSON.parse(await readFile(MEDIA_JSON, "utf8"));
  } catch {
    return { items: {} }; // items[fileId] = {name,mimeType,tags,mood,description,used}
  }
}
async function saveManifest(m) {
  await mkdir(dirname(MEDIA_JSON), { recursive: true });
  await writeFile(MEDIA_JSON, JSON.stringify(m, null, 2), "utf8");
}

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description: "По одному объекту на каждое изображение, СТРОГО в том же порядке",
      items: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string", enum: TAG_VOCAB }, description: "1-4 тега из словаря" },
          mood: { type: "string", description: "одно слово об эмоции/настроении укр." },
          description: { type: "string", description: "короткое описание укр., что на фото" },
        },
        required: ["tags", "mood", "description"],
        propertyOrdering: ["tags", "mood", "description"],
      },
    },
  },
  required: ["items"],
};

const PROMPT = `Ти — асистент, що розмічає фото/відео для жіночого блогу про відновлення, материнство, любов до себе.
Подивись на КОЖНЕ зображення (це превʼю файлу) і для кожного поверни: теги зі словника, настрій і короткий опис українською.
Відповідай масивом РІВНО в тому ж порядку, що й зображення. Обери 1-4 найточніші теги.`;

// Отегать новые файлы. Возвращает {tagged, total, skipped, tokens}.
export async function tagNewMedia({ limit = Infinity } = {}) {
  const manifest = await loadManifest();
  const files = await listMedia();
  const fresh = files.filter((f) => !manifest.items[f.id]).slice(0, limit);
  if (fresh.length === 0) {
    console.log(`✅ Новых файлов нет (в манифесте ${Object.keys(manifest.items).length}).`);
    return { tagged: 0, total: files.length, skipped: 0, tokens: 0 };
  }
  console.log(`🔎 Новых файлов: ${fresh.length} (всего в FOTO ${files.length}). Тегаю батчами по ${BATCH_SIZE}...`);
  const c = await getClient();
  let tagged = 0, tokens = 0, skipped = 0;

  for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
    const batch = fresh.slice(i, i + BATCH_SIZE);
    const parts = [{ text: PROMPT }];
    const usable = [];
    for (const f of batch) {
      try {
        const { buffer, mimeType } = await getThumbnail(f, 512);
        parts.push({ inlineData: { mimeType: mimeType.startsWith("image") ? mimeType : "image/jpeg", data: buffer.toString("base64") } });
        usable.push(f);
      } catch (e) {
        console.warn(`  ⚠️ превью не получено: ${f.name} (${e.message})`);
        skipped++;
      }
    }
    if (usable.length === 0) continue;

    const resp = await c.models.generateContent({
      model: MODEL,
      contents: parts,
      config: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.4 },
    });
    tokens += resp?.usageMetadata?.totalTokenCount || 0;
    let data;
    try { data = JSON.parse(resp.text); } catch { data = { items: [] }; }
    const items = Array.isArray(data.items) ? data.items : [];
    usable.forEach((f, idx) => {
      const r = items[idx] || {};
      manifest.items[f.id] = {
        name: f.name,
        mimeType: f.mimeType,
        tags: Array.isArray(r.tags) ? r.tags : [],
        mood: r.mood || "",
        description: r.description || "",
        used: false,
      };
      tagged++;
      console.log(`  ${f.mimeType.startsWith("video") ? "🎬" : "🖼️"} ${f.name} → [${(r.tags || []).join(", ")}] ${r.mood || ""}`);
    });
    await saveManifest(manifest); // прогресс после каждого батча
  }

  console.log(`\n✅ Отегано: ${tagged}, пропущено: ${skipped}. Токенов потрачено: ${tokens}. Манифест: data/media.json`);
  return { tagged, total: files.length, skipped, tokens };
}

// Подбор медиа под пост — БЕЗ ИИ, чистый код. brief.themeId/segment/formatFamily → желаемые теги.
const THEME_TAGS = {
  bil_vygorannia: ["втома_сум", "жінка_сама", "портрет_обличчя"],
  bil_vtrata_sebe: ["жінка_сама", "портрет_обличчя", "втома_сум"],
  bil_dlia_vsih: ["мама_з_дитиною", "діти", "робота_ноутбук"],
  bil_toksychni: ["жінка_сама", "втома_сум", "портрет_обличчя"],
  vidnov_syly: ["природа", "море_пляж", "йога_медитація", "кава_сніданок"],
  vidnov_praktyky: ["йога_медитація", "кава_сніданок", "дім_затишок", "природа"],
  lyubov_do_sebe: ["краса_догляд", "портрет_обличчя", "радість_світло"],
  lyubov_dozvil: ["дім_затишок", "кава_сніданок", "радість_світло"],
  lyubov_mify: ["портрет_обличчя", "жінка_сама"],
  istoria_diana: ["мама_з_дитиною", "вагітна", "діти", "портрет_обличчя"],
  istoria_zhinok: ["жінка_сама", "мама_з_дитиною", "портрет_обличчя"],
  energia_napovnennia: ["радість_світло", "море_пляж", "краса_догляд", "квіти"],
  energia_vdiachnist: ["радість_світло", "природа", "захід_сонця", "квіти"],
};

export function desiredTags(brief) {
  const t = new Set(THEME_TAGS[brief.themeId] || []);
  const seg = brief.segment || "";
  if (seg.includes("мама") || seg.includes("декрет") || seg.includes("післяполог")) { t.add("мама_з_дитиною"); t.add("діти"); }
  if (seg.includes("вагітн")) t.add("вагітна");
  if (seg.includes("стосунк") || seg.includes("розлуч")) t.add("пара_стосунки");
  return [...t];
}

// Выбрать лучший неиспользованный медиа под пост. videoOk — разрешить видео.
export function pickMedia(manifest, brief, { videoOk = true } = {}) {
  const want = new Set(desiredTags(brief));
  const candidates = Object.entries(manifest.items)
    .filter(([, m]) => !m.used && (videoOk || m.mimeType.startsWith("image")))
    .map(([id, m]) => {
      const overlap = (m.tags || []).filter((tg) => want.has(tg)).length;
      return { id, m, score: overlap };
    })
    .sort((a, b) => b.score - a.score);
  if (candidates.length === 0) return null;
  // берём из топа по совпадению (если совпадений нет — любой неиспользованный)
  const top = candidates.filter((c) => c.score === candidates[0].score);
  const chosen = top[Math.floor(Math.random() * top.length)];
  return { id: chosen.id, ...chosen.m, score: chosen.score };
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("vision.js")) {
  const args = process.argv.slice(2);
  const li = args.indexOf("--limit");
  const limit = li !== -1 ? Number(args[li + 1]) : Infinity;
  await tagNewMedia({ limit });
}
