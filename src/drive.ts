/**
 * Minimal Google Drive client (REST, no SDK) using an OAuth refresh token.
 * Scope: drive.file → the server only sees files/folders it created itself.
 */

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN ?? "";
export const DRIVE_ROOT = process.env.DRIVE_ROOT_FOLDER ?? "Mail-Anhänge";

export const driveConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);

const FOLDER = "application/vnd.google-apps.folder";
let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`Google-Login fehlgeschlagen: ${j.error ?? res.status} ${j.error_description ?? ""}`);
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(init.headers ?? {}) },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Drive-API ${res.status}: ${j.error?.message ?? res.statusText}`);
  return j;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function findChild(parent: string, name: string, mime?: string) {
  const q = [`name = '${esc(name)}'`, `'${parent}' in parents`, "trashed = false", mime ? `mimeType = '${mime}'` : ""]
    .filter(Boolean)
    .join(" and ");
  const r = await api(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)&pageSize=1`);
  return r.files?.[0] as { id: string; name: string; webViewLink?: string } | undefined;
}

const folderCache = new Map<string, string>();

/** Returns the folder id for "Root/a/b/c", creating missing folders. */
export async function ensurePath(relPath: string): Promise<string> {
  const parts = [DRIVE_ROOT, ...relPath.split("/").map((p) => p.trim()).filter(Boolean)];
  let parent = "root";
  let key = "";
  for (const name of parts) {
    key += "/" + name;
    const hit = folderCache.get(key);
    if (hit) {
      parent = hit;
      continue;
    }
    const existing = await findChild(parent, name, FOLDER);
    const id =
      existing?.id ??
      (
        await api("/drive/v3/files?fields=id", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
        })
      ).id;
    folderCache.set(key, id);
    parent = id;
  }
  return parent;
}

export async function uploadFile(relPath: string, filename: string, contentType: string, data: Buffer, description?: string) {
  const parent = await ensurePath(relPath);
  const existing = await findChild(parent, filename);
  if (existing) return { status: "exists", id: existing.id, link: existing.webViewLink ?? null, path: `${DRIVE_ROOT}/${relPath}/${filename}` };

  const boundary = "webdemcp" + Math.random().toString(16).slice(2);
  const meta = JSON.stringify({ name: filename, parents: [parent], description });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await api("/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return { status: "uploaded", id: r.id, link: r.webViewLink ?? null, path: `${DRIVE_ROOT}/${relPath}/${filename}` };
}
