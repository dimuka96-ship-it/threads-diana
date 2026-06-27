// Постер в Threads через официальный API (двухшаговая публикация).
// Поддерживает текст, ФОТО и ВИДЕО. Медиа берётся по публичному URL (raw из репо).
// Читает data/queue.json, публикует и проставляет статус обратно в файл.
//
// Шаги Threads API:
//   1) POST /{user-id}/threads          → создать контейнер (creation_id)
//   2) дождаться готовности контейнера (status=FINISHED), для видео дольше
//   3) POST /{user-id}/threads_publish  → опубликовать по creation_id
//
// Запуск:
//   node --env-file=.env src/post.js                  # сухой прогон
//   node --env-file=.env src/post.js --test           # опубликовать ОДИН первый черновик сейчас
//   node --env-file=.env src/post.js --publish        # опубликовать «созревшие» (scheduled_at <= now)
//   node --env-file=.env src/post.js --publish --all  # опубликовать все черновики, игнорируя расписание

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUEUE = join(ROOT, "data", "queue.json");
const BASE = "https://graph.threads.net/v1.0";

const USER_ID = process.env.THREADS_USER_ID;
const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const WAIT_MS = Number(process.env.THREADS_PUBLISH_WAIT_MS || 35000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireCreds() {
  if (!USER_ID || !TOKEN) {
    console.error("❌ В .env нет THREADS_USER_ID / THREADS_ACCESS_TOKEN. Сначала: node --env-file=.env src/auth.js me <token>");
    process.exit(1);
  }
}

// Создать медиа-контейнер: TEXT, IMAGE или VIDEO (по полям поста).
async function createContainer(post) {
  const params = new URLSearchParams({ access_token: TOKEN });
  const type = (post.media_type || "TEXT").toUpperCase();
  if (type === "IMAGE" && post.media_url) {
    params.set("media_type", "IMAGE");
    params.set("image_url", post.media_url);
    params.set("text", post.post);
  } else if (type === "VIDEO" && post.media_url) {
    params.set("media_type", "VIDEO");
    params.set("video_url", post.media_url);
    params.set("text", post.post);
  } else {
    params.set("media_type", "TEXT");
    params.set("text", post.post);
  }
  const r = await fetch(`${BASE}/${USER_ID}/threads`, { method: "POST", body: params });
  const d = await r.json();
  if (!d.id) throw new Error("создание контейнера: " + JSON.stringify(d));
  return d.id;
}

// Дождаться, пока контейнер обработается (особенно важно для видео).
async function waitReady(creationId, isVideo) {
  const maxTries = isVideo ? 20 : 3; // видео обрабатывается дольше
  for (let i = 0; i < maxTries; i++) {
    await sleep(isVideo ? 15000 : WAIT_MS / 3 + 1);
    try {
      const r = await fetch(`${BASE}/${creationId}?fields=status,error_message&access_token=${TOKEN}`);
      const d = await r.json();
      if (d.status === "FINISHED") return true;
      if (d.status === "ERROR") throw new Error("контейнер ERROR: " + (d.error_message || ""));
    } catch (e) {
      if (String(e.message).includes("ERROR")) throw e;
    }
  }
  return true; // пробуем опубликовать даже если статус не подтвердился
}

async function publishContainer(creationId) {
  const params = new URLSearchParams({ creation_id: creationId, access_token: TOKEN });
  const r = await fetch(`${BASE}/${USER_ID}/threads_publish`, { method: "POST", body: params });
  const d = await r.json();
  if (!d.id) throw new Error("публикация: " + JSON.stringify(d));
  return d.id;
}

async function getPermalink(mediaId) {
  try {
    const r = await fetch(`${BASE}/${mediaId}?fields=permalink&access_token=${TOKEN}`);
    const d = await r.json();
    return d.permalink || null;
  } catch {
    return null;
  }
}

async function publishOne(post) {
  if (post.char_count > 500 || (post.post && post.post.length > 500)) {
    throw new Error(`пост длиннее 500 символов (${post.post.length})`);
  }
  const isVideo = (post.media_type || "").toUpperCase() === "VIDEO";
  const creationId = await createContainer(post);
  const tag = post.media_url ? `${post.media_type} ${post.media_file || ""}` : "текст";
  console.log(`   контейнер ${creationId} (${tag}) создан, жду обработки...`);
  await waitReady(creationId, isVideo);
  const mediaId = await publishContainer(creationId);
  const permalink = await getPermalink(mediaId);
  return { mediaId, permalink };
}

async function main() {
  const args = process.argv.slice(2);
  const test = args.includes("--test");
  const publish = args.includes("--publish") || test;
  const all = args.includes("--all");

  const queue = JSON.parse(await readFile(QUEUE, "utf8"));
  const now = Date.now();

  let targets = queue.posts.filter((p) => p.status === "draft");
  if (test) targets = targets.slice(0, 1);
  else if (!all) targets = targets.filter((p) => new Date(p.scheduled_at).getTime() <= now);

  const limIdx = args.indexOf("--limit");
  if (limIdx !== -1) targets = targets.slice(0, Number(args[limIdx + 1]) || targets.length);

  if (targets.length === 0) {
    console.log("Нет постов к публикации. Подсказка: --all или --test.");
    return;
  }

  if (!publish) {
    console.log(`Сухой прогон — будет опубликовано ${targets.length} пост(ов):\n`);
    targets.forEach((p, i) => {
      const media = p.media_url ? ` +${p.media_type}(${p.media_file})` : "";
      console.log(`${i + 1}. [${p.pillar}]${media} ${p.scheduled_at?.slice(0, 16).replace("T", " ")}  (${p.char_count} симв.)`);
      console.log(`   ${p.post.replace(/\n/g, " ⏎ ").slice(0, 160)}...\n`);
    });
    console.log("Для реальной публикации добавьте --publish (или --test).");
    return;
  }

  requireCreds();
  console.log(`Публикую ${targets.length} пост(ов) как @threads user ${USER_ID}\n`);

  for (let i = 0; i < targets.length; i++) {
    const post = targets[i];
    console.log(`▶ ${i + 1}/${targets.length} [${post.pillar}]`);
    try {
      const { mediaId, permalink } = await publishOne(post);
      post.status = "published";
      post.published_at = new Date().toISOString();
      post.thread_id = mediaId;
      post.permalink = permalink;
      console.log(`   ✅ опубликовано: ${permalink || mediaId}`);
    } catch (e) {
      post.status = "error";
      post.error = e.message;
      console.error(`   ❌ ${e.message}`);
    }
    await writeFile(QUEUE, JSON.stringify(queue, null, 2), "utf8");
  }
  console.log("\nГотово. Статусы обновлены в data/queue.json.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
