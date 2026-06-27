// Ресёрч-модуль: Gemini с граундингом через Google Search тянет свежие реальные
// факты/кейсы/тренды по нише и сохраняет структурированные «инсайты» в data/insights.json.
// Эти инсайты потом использует генератор как ОПОРУ (переписывая своими словами).
//
// Запуск:
//   node --env-file=.env src/research.js                 # прогнать все темы
//   node --env-file=.env src/research.js "своя тема"     # добавить разовый запрос

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const OUT = join(DATA, "insights.json");
const MODEL = process.env.GEMINI_RESEARCH_MODEL || process.env.GEMINI_MODEL || "gemini-3.5-flash";

// Темы ресёрча: tags нужны генератору, чтобы подбирать инсайт под тему. Ниша «Поверни себе собі».
const TOPICS = [
  { q: "емоційне вигорання у жінок і мам: ознаки, причини, як відновлюватись, свіжі поради психологів 2026", tags: ["bil_vygorannia", "vidnov_syly"] },
  { q: "післяпологова депресія і втрата себе після пологів: що допомагає жінці повернутись до себе 2026", tags: ["bil_vtrata_sebe", "istoria_zhinok"] },
  { q: "турбота про себе для жінок без езотерики: реальні щоденні практики, межі, дозвіл собі, що працює 2026", tags: ["vidnov_praktyky", "lyubov_dozvil"] },
  { q: "любов до себе і самоцінність жінки: робочі психологічні техніки та інсайти 2026", tags: ["lyubov_do_sebe", "lyubov_dozvil"] },
  { q: "токсичні стосунки: як жінка втрачає себе і як це розпізнати, поради психологів 2026", tags: ["bil_toksychni"] },
  { q: "жіноча енергія і наповнення, як повернути радість і насолоду в життя жінки, практики 2026", tags: ["energia_napovnennia", "energia_vdiachnist"] },
  { q: "які теми, формати й хуки зараз залітають у Threads та Instagram у жіночій психологічній ніші 2026", tags: ["istoria_zhinok", "vidnov_praktyky"] },
  { q: "жінка живе для всіх крім себе, не вміє казати ні й просити допомоги: причини й що з цим робити 2026", tags: ["bil_dlia_vsih", "lyubov_dozvil"] },
];

function apiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

// Достать JSON-массив из ответа модели (учитывая ```json ... ``` обёртки).
function extractJson(text) {
  if (!text) return [];
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s === -1 || e === -1 || e < s) return [];
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return [];
  }
}

async function researchTopic(ai, topic) {
  const prompt = `Тема: «${topic.q}».
Найди в интернете свежую и КОНКРЕТНУЮ информацию: реальные приёмы, цифры, кейсы, тренды, возможности инструментов, пользовательский опыт.
Верни ТОЛЬКО JSON-массив из 2-3 объектов вида:
[{"topic":"короткая суть","facts":["конкретный факт/цифра/приём","ещё факт"],"example":"короткий реальный пример или кейс, если есть, иначе пустая строка"}]
Без пояснений, без markdown — только массив JSON.`;

  const resp = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: { tools: [{ googleSearch: {} }] },
  });
  const items = extractJson(resp.text);
  return items.map((it, idx) => ({
    id: `${topic.tags[0]}-${Date.now()}-${idx}`,
    topic: it.topic || topic.q,
    facts: Array.isArray(it.facts) ? it.facts : [],
    example: it.example || "",
    tags: topic.tags,
  }));
}

async function main() {
  if (!apiKey()) {
    console.error("❌ Нет GEMINI_API_KEY в .env");
    process.exit(1);
  }
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: apiKey() });

  const extra = process.argv.slice(2).join(" ").trim();
  const topics = extra ? [{ q: extra, tags: ["custom"] }] : TOPICS;

  const all = [];
  for (const t of topics) {
    process.stdout.write(`🔎 ${t.q.slice(0, 60)}... `);
    try {
      const items = await researchTopic(ai, t);
      all.push(...items);
      console.log(`+${items.length}`);
    } catch (e) {
      console.log(`ошибка: ${e.message}`);
    }
  }

  await mkdir(DATA, { recursive: true });
  // если добавляем разовую тему — дописываем к существующим
  let merged = all;
  if (extra) {
    const prev = JSON.parse(await readFile(OUT, "utf8").catch(() => "[]"));
    merged = [...prev, ...all];
  }
  await writeFile(OUT, JSON.stringify(merged, null, 2), "utf8");
  console.log(`\n📚 Сохранено инсайтов: ${merged.length} → data/insights.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
