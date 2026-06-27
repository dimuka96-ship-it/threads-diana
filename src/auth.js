// Помощник авторизации Threads API.
// Делает рутину шага 5: строит ссылку авторизации, меняет code на токен,
// обменивает на long-lived (60 дней), достаёт user_id и пишет всё в .env.
//
// Нужно в .env: THREADS_APP_ID, THREADS_APP_SECRET
// (берутся в приложении: App settings → Basic — App ID и App Secret).
//
// Использование:
//   node --env-file=.env src/auth.js url            # вывести ссылку авторизации
//   node --env-file=.env src/auth.js exchange <code> # обменять code на токен и записать в .env

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");

const REDIRECT = process.env.THREADS_REDIRECT_URI || "https://localhost/";
const SCOPE = "threads_basic,threads_content_publish";

const appId = process.env.THREADS_APP_ID;
const appSecret = process.env.THREADS_APP_SECRET;

function requireApp() {
  if (!appId || !appSecret) {
    console.error("❌ В .env нет THREADS_APP_ID / THREADS_APP_SECRET (App settings → Basic).");
    process.exit(1);
  }
}

// Записать/обновить ключ в .env, не трогая остальное.
async function setEnv(updates) {
  let text = "";
  try {
    text = await readFile(ENV_PATH, "utf8");
  } catch {}
  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : text + (text.endsWith("\n") || text === "" ? "" : "\n") + line + "\n";
  }
  await writeFile(ENV_PATH, text.endsWith("\n") ? text : text + "\n", "utf8");
}

function printUrl() {
  requireApp();
  const url =
    `https://threads.net/oauth/authorize?client_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&scope=${encodeURIComponent(SCOPE)}&response_type=code`;
  console.log("\nОткройте в браузере, подтвердите доступ, затем скопируйте code из адреса https://localhost/?code=...\n");
  console.log(url + "\n");
}

async function exchange(code) {
  requireApp();
  if (!code) {
    console.error("❌ Укажите код: node --env-file=.env src/auth.js exchange <code>");
    process.exit(1);
  }
  code = code.split("#")[0]; // убрать хвост #_

  // 1) code -> short-lived token (+ user_id)
  const shortResp = await fetch("https://graph.threads.net/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      code,
    }),
  });
  const short = await shortResp.json();
  if (!short.access_token) {
    console.error("❌ Ошибка обмена кода:", JSON.stringify(short));
    process.exit(1);
  }
  console.log(`✅ Short-lived токен получен. user_id=${short.user_id}`);

  // 2) short-lived -> long-lived (60 дней)
  const longUrl =
    `https://graph.threads.net/access_token?grant_type=th_exchange_token` +
    `&client_secret=${appSecret}&access_token=${short.access_token}`;
  const longResp = await fetch(longUrl);
  const long = await longResp.json();
  if (!long.access_token) {
    console.error("⚠️  Не удалось обменять на long-lived, оставляю короткий:", JSON.stringify(long));
  }

  const token = long.access_token || short.access_token;
  const expires = long.expires_in ? Math.round(long.expires_in / 86400) : "≈1 час";

  await setEnv({
    THREADS_ACCESS_TOKEN: token,
    THREADS_USER_ID: String(short.user_id),
  });
  console.log(`✅ Записал в .env: THREADS_ACCESS_TOKEN (срок: ${expires} дн.), THREADS_USER_ID=${short.user_id}`);
  console.log("Готово — можно делать постер.");
}

// Путь через «Генератор маркеров пользователя»: токен уже есть, нужен только user_id.
async function me(token) {
  token = token || process.env.THREADS_ACCESS_TOKEN;
  if (!token) {
    console.error("❌ Дайте токен: node --env-file=.env src/auth.js me <token>  (или впишите THREADS_ACCESS_TOKEN в .env)");
    process.exit(1);
  }
  const resp = await fetch(`https://graph.threads.net/v1.0/me?fields=id,username&access_token=${token}`);
  const data = await resp.json();
  if (!data.id) {
    console.error("❌ Ошибка:", JSON.stringify(data));
    process.exit(1);
  }
  await setEnv({ THREADS_ACCESS_TOKEN: token, THREADS_USER_ID: data.id });
  console.log(`✅ @${data.username}, user_id=${data.id} — записал в .env. Готово к постеру.`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "url") printUrl();
else if (cmd === "exchange") await exchange(arg);
else if (cmd === "me") await me(arg);
else {
  console.log("Команды:\n  node --env-file=.env src/auth.js me <token>        # путь через Генератор маркеров (проще)\n  node --env-file=.env src/auth.js url\n  node --env-file=.env src/auth.js exchange <code>");
}
