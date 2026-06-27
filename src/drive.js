// Доступ к Google Drive сервис-аккаунтом — без сторонних зависимостей.
// Аутентификация: подписанный JWT (RS256) → access_token (OAuth2 service account).
// Используется ботом в GitHub Actions, где claude.ai-коннектора нет.
//
// Ключ берётся из переменной GOOGLE_SERVICE_ACCOUNT_JSON (содержимое JSON)
// или из файла service-account.json в корне проекта.
//
// CLI для проверки:
//   node --env-file=.env src/drive.js list           # показать файлы в папке FOTO
//   node --env-file=.env src/drive.js get <fileId>    # скачать файл в data/media/

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createSign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = join(ROOT, "service-account.json");
const MEDIA_DIR = join(ROOT, "data", "media");

// id папки FOTO на Google Drive (живая, пополняется). Можно переопределить через env.
export const FOTO_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "1ypnGt5Hpxrrp3cLzDDSkTLoklLSqcHuW";

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

let creds = null;
async function loadCreds() {
  if (creds) return creds;
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || (await readFile(KEY_FILE, "utf8"));
  raw = raw.replace(/^﻿/, "").trim(); // срезаем BOM/пробелы (бывает при заливке секрета через PowerShell)
  creds = JSON.parse(raw);
  return creds;
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let cachedToken = null; // { token, exp }
export async function getAccessToken() {
  if (cachedToken && cachedToken.exp - 60 > Math.floor(Date.now() / 1000)) return cachedToken.token;
  const c = await loadCreds();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: c.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat, exp }));
  const signingInput = `${header}.${claim}`;
  const signature = b64url(createSign("RSA-SHA256").update(signingInput).sign(c.private_key));
  const assertion = `${signingInput}.${signature}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("OAuth: " + JSON.stringify(data));
  cachedToken = { token: data.access_token, exp };
  return data.access_token;
}

// Список медиа в папке (фото и видео). Возвращает [{id,name,mimeType,size,thumbnailLink,modifiedTime}].
export async function listMedia(folderId = FOTO_FOLDER_ID) {
  const token = await getAccessToken();
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')`,
      fields: "nextPageToken, files(id,name,mimeType,size,thumbnailLink,modifiedTime)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await r.json();
    if (d.error) throw new Error("Drive list: " + JSON.stringify(d.error));
    files.push(...(d.files || []));
    pageToken = d.nextPageToken || "";
  } while (pageToken);
  return files;
}

// Скачать полный файл в Buffer.
export async function downloadFile(fileId) {
  const token = await getAccessToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drive download ${fileId}: ${r.status} ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}

// Маленькое превью для ИИ-зрения (дёшево по токенам). Для фото И видео Drive отдаёт thumbnailLink.
// size — желаемая ширина (подменяем суффикс =sNNN). Фоллбэк — полный файл.
export async function getThumbnail(file, size = 512) {
  if (file.thumbnailLink) {
    const url = file.thumbnailLink.replace(/=s\d+(-c)?$/, `=s${size}`);
    const r = await fetch(url);
    if (r.ok) return { buffer: Buffer.from(await r.arrayBuffer()), mimeType: "image/jpeg" };
  }
  // фоллбэк: качаем оригинал (дороже). Для видео превью без thumbnailLink не получить — пропустим выше.
  return { buffer: await downloadFile(file.id), mimeType: file.mimeType };
}

export async function saveToMedia(fileId, name) {
  await mkdir(MEDIA_DIR, { recursive: true });
  const buf = await downloadFile(fileId);
  const out = join(MEDIA_DIR, name);
  await writeFile(out, buf);
  return out;
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("drive.js")) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "list") {
    const files = await listMedia();
    console.log(`📁 FOTO: ${files.length} файлов`);
    files.forEach((f) =>
      console.log(`  ${f.mimeType.startsWith("video") ? "🎬" : "🖼️"} ${f.name}  (${Math.round((f.size || 0) / 1024)}KB)  thumb:${f.thumbnailLink ? "да" : "нет"}`),
    );
  } else if (cmd === "get") {
    const files = await listMedia();
    const f = files.find((x) => x.id === arg) || { id: arg, name: `${arg}.bin` };
    const out = await saveToMedia(f.id, f.name);
    console.log("✅ скачано:", out);
  } else {
    console.log("Команды: list | get <fileId>");
  }
}
