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
  limit: number;
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
      if (Object.keys(q).length === 0) q.all = true;

      const uids = (await c.search(q, { uid: true })) || [];
      const pick = uids.slice(-a.limit).reverse(); // newest first
      if (pick.length === 0) return [];

      const out: unknown[] = [];
      for await (const m of c.fetch(pick, { envelope: true, flags: true, uid: true }, { uid: true })) {
        out.push({
          uid: m.uid,
          date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
          from: m.envelope?.from?.map((x) => `${x.name ?? ""} <${x.address}>`.trim()) ?? [],
          to: m.envelope?.to?.map((x) => x.address) ?? [],
          subject: m.envelope?.subject ?? "",
          seen: m.flags?.has("\\Seen") ?? false,
        });
      }
      return out.sort((x: any, y: any) => (y.uid as number) - (x.uid as number));
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
        attachments: p.attachments.map((x) => ({ filename: x.filename, contentType: x.contentType, size: x.size })),
      };
    } finally {
      lock.release();
    }
  });
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
