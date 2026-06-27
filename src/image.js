// Генерация иллюстраций к постам через image-модель Gemini.
// Стиль: современный минимализм, строго чёрно-белый, без фейковых скринов UI.
//
// Использование:
//   node --env-file=.env src/image.js "идея картинки"
//   node --env-file=.env src/image.js            # дефолтная тест-идея

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMG_DIR = join(ROOT, "data", "images");
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";

// Единый арт-дирекшн: иллюстрация в стиле рекламного кабинета (НЕ реальный скрин).
const STYLE = `A sleek, modern advertising analytics dashboard UI illustration — in the visual style of Google Ads / Meta Ads Manager. Clean product-design mockup: a row of metric cards (impressions, clicks, CTR, cost-per-lead, conversions), one large line/area chart trending upward, a thin left sidebar with simple nav icons. Modern flat UI, crisp sans-serif, light theme with a single accent color, soft shadows, rounded corners, lots of structure. High quality, polished, professional. Square 1:1.
It is a stylized ILLUSTRATION / design mockup with example data — not a real captured screenshot. Keep any numbers realistic and generic.
Focus / data story:`;

function apiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

export async function generateImage(idea, outPath) {
  if (!apiKey()) throw new Error("нет GEMINI_API_KEY в .env");
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: apiKey() });

  const resp = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: `${STYLE} ${idea}`,
  });

  const parts = resp?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) {
    const txt = parts.map((p) => p.text).filter(Boolean).join(" ");
    throw new Error("модель не вернула изображение. Ответ: " + (txt || JSON.stringify(resp).slice(0, 300)));
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, Buffer.from(img.inlineData.data, "base64"));
  return outPath;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("image.js")) {
  const idea =
    process.argv.slice(2).join(" ") ||
    "Восходящий график числа заявок с крупной подписью «+42%», иконка цели/мишени, лаконичная сетка.";
  const out = join(IMG_DIR, `test-${Date.now()}.png`);
  generateImage(idea, out)
    .then((p) => console.log("✅ Картинка сохранена:", p))
    .catch((e) => {
      console.error("❌", e.message);
      process.exit(1);
    });
}
