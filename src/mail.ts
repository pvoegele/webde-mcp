import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env var ${name}`);
  return v;
};

export const config = {
  user: env("WEBDE_USER"),
  pass: env("WEBDE_PASSWORD"),
  imapHost: env("IMAP_HOST", "imap.web.de"),
  imapPort: Number(env("IMAP_PORT", "993")),
  smtpHost: env("SMTP_HOST", "smtp.web.de"),
  smtpPort: Number(env("SMTP_PORT", "587")),
  fromName: process.env.FROM_NAME ?? "",
};

/** Opens a fresh IMAP connection, runs fn, and always logs out. */
export async function withImap<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export async function listFolders() {
  return withImap(async (c) => {
    const list = await c.list({ statusQuery: { messages: true, unseen: true } });
    return list.map((f) => ({
      path: f.path,
      specialUse: f.specialUse ?? null,
      messages: f.status?.messages ?? null,
      unseen: f.status?.unseen ?? null,
    }));
  });
}

export interface SearchArgs {
  folder: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  unseen?: boolean;
  has_attachments?: boolean;
  exclude_saved?: boolean;
  limit: number;
}

/** IMAP keyword set on a message once its attachments were filed to Drive. */
export const SAVED_KEYWORD = "$DriveSaved";

/** Counts real attachments (not inline images / body parts) in an IMAP BODYSTRUCTURE. */
function countAttachments(node: any): number {
  if (!node) return 0;
  if (node.childNodes?.length) return node.childNodes.reduce((n: number, c: any) => n + countAttachments(c), 0);
  const name = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (node.disposition === "attachment") return 1;
  if (name && node.disposition !== "inline" && !String(node.type).startsWith("text/")) return 1;
  return 0;
}

export async function searchEmails(a: SearchArgs) {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(a.folder);
    try {
      const q: Record<string, unknown> = {};
      if (a.from) q.from = a.from;
      if (a.to) q.to = a.to;
      if (a.subject) q.subject = a.subject;
      if (a.text) q.body = a.text;
      if (a.since) q.since = new Date(a.since);
      if (a.before) q.before = new Date(a.before);
      if (a.unseen) q.seen = false;
      if (a.exclude_saved) q.unKeyword = SAVED_KEYWORD;
      if (Object.keys(q).length === 0) q.all = true;

      const uids = ((await c.search(q, { uid: true })) || []).reverse(); // newest first
      // With has_attachments we have to inspect structures, so scan a larger window.
      const scan = a.has_attachments ? uids.slice(0, Math.min(uids.length, a.limit * 10, 1000)) : uids.slice(0, a.limit);
      if (scan.length === 0) return [];

      const out: any[] = [];
      for await (const m of c.fetch(scan, { envelope: true, flags: true, uid: true, bodyStructure: true }, { uid: true })) {
        const attachments = countAttachments(m.bodyStructure);
        if (a.has_attachments && attachments === 0) continue;
        out.push({
          attachments,
          drive_saved: m.flags?.has(SAVED_KEYWORD) ?? false,
          uid: m.uid,
          date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
          from: m.envelope?.from?.map((x) => `${x.name ?? ""} <${x.address}>`.trim()) ?? [],
          to: m.envelope?.to?.map((x) => x.address) ?? [],
          subject: m.envelope?.subject ?? "",
          seen: m.flags?.has("\\Seen") ?? false,
        });
      }
      return out.sort((x, y) => y.uid - x.uid).slice(0, a.limit);
    } finally {
      lock.release();
    }
  });
}

export async function getEmail(folder: string, uid: number, maxChars: number) {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`No message with UID ${uid} in ${folder}`);
      const p = await simpleParser(msg.source);
      const text = p.text ?? (typeof p.html === "string" ? p.html.replace(/<[^>]+>/g, " ") : "");
      return {
        uid,
        messageId: p.messageId ?? null,
        date: p.date?.toISOString() ?? null,
        from: p.from?.text ?? "",
        to: Array.isArray(p.to) ? p.to.map((t) => t.text).join(", ") : p.to?.text ?? "",
        cc: Array.isArray(p.cc) ? p.cc.map((t) => t.text).join(", ") : p.cc?.text ?? "",
        subject: p.subject ?? "",
        text: text.length > maxChars ? text.slice(0, maxChars) + "\n…[gekürzt]" : text,
        attachments: listAttachments(p.attachments),
      };
    } finally {
      lock.release();
    }
  });
}

type ParsedAttachment = Awaited<ReturnType<typeof simpleParser>>["attachments"][number];

function isRealAttachment(x: ParsedAttachment) {
  return !(x.related || (x.contentDisposition === "inline" && x.contentType.startsWith("image/")));
}

function listAttachments(atts: ParsedAttachment[]) {
  return atts
    .map((x, index) => ({ index, filename: x.filename ?? `anhang-${index}`, contentType: x.contentType, size: x.size, real: isRealAttachment(x) }))
    .filter((x) => x.real)
    .map(({ real, ...rest }) => rest);
}

export interface LoadedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  mail: { uid: number; date: string | null; from: string; subject: string };
}

/** Downloads one attachment (by index from get_email) of a message. */
export async function loadAttachment(folder: string, uid: number, index: number): Promise<LoadedAttachment> {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`No message with UID ${uid} in ${folder}`);
      const p = await simpleParser(msg.source);
      const att = p.attachments[index];
      if (!att) throw new Error(`Mail ${uid} hat keinen Anhang mit index ${index}`);
      return {
        filename: att.filename ?? `anhang-${index}`,
        contentType: att.contentType,
        content: att.content,
        mail: { uid, date: p.date?.toISOString() ?? null, from: p.from?.text ?? "", subject: p.subject ?? "" },
      };
    } finally {
      lock.release();
    }
  });
}

/** Marks messages as filed to Drive (IMAP keyword). Best effort: some servers reject custom keywords. */
export async function markSaved(folder: string, uids: number[]) {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      return await c.messageFlagsAdd(uids.join(","), [SAVED_KEYWORD], { uid: true });
    } finally {
      lock.release();
    }
  }).catch(() => false);
}

export async function setFlags(folder: string, uids: number[], seen: boolean) {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const range = uids.join(",");
      if (seen) await c.messageFlagsAdd(range, ["\\Seen"], { uid: true });
      else await c.messageFlagsRemove(range, ["\\Seen"], { uid: true });
      return { updated: uids.length };
    } finally {
      lock.release();
    }
  });
}

export async function moveEmails(folder: string, uids: number[], target: string) {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      await c.messageMove(uids.join(","), target, { uid: true });
      return { moved: uids.length, to: target };
    } finally {
      lock.release();
    }
  });
}

const transport = () =>
  nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    requireTLS: config.smtpPort !== 465,
    auth: { user: config.user, pass: config.pass },
  });

export interface SendArgs {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
}

export async function sendEmail(a: SendArgs) {
  const raw = {
    from: config.fromName ? `"${config.fromName}" <${config.user}>` : config.user,
    to: a.to,
    cc: a.cc,
    bcc: a.bcc,
    subject: a.subject,
    text: a.text,
    html: a.html,
    inReplyTo: a.inReplyTo,
    references: a.inReplyTo,
  };
  const info = await transport().sendMail(raw);

  // web.de does not store SMTP-sent mail automatically → append a copy to "Gesendet".
  try {
    const mc = new (await import("nodemailer/lib/mail-composer/index.js")).default(raw);
    const msg: Buffer = await new Promise((res, rej) => mc.compile().build((e: any, b: Buffer) => (e ? rej(e) : res(b))));
    await withImap(async (c) => {
      const sent = (await c.list()).find((f) => f.specialUse === "\\Sent")?.path ?? "Gesendet";
      await c.append(sent, msg, ["\\Seen"]);
    });
  } catch {
    /* copy to Sent is best effort */
  }
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

export async function saveDraft(a: SendArgs) {
  const mc = new (await import("nodemailer/lib/mail-composer/index.js")).default({
    from: config.user, to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, text: a.text, html: a.html,
  });
  const msg: Buffer = await new Promise((res, rej) => mc.compile().build((e: any, b: Buffer) => (e ? rej(e) : res(b))));
  return withImap(async (c) => {
    const drafts = (await c.list()).find((f) => f.specialUse === "\\Drafts")?.path ?? "Entwürfe";
    await c.append(drafts, msg, ["\\Draft"]);
    return { savedTo: drafts };
  });
}
