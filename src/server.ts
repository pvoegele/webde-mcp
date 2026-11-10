import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as mail from "./mail.js";

const TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
if (TOKEN.length < 32) throw new Error("MCP_AUTH_TOKEN must be set (>= 32 chars). Generate: openssl rand -hex 32");
const PORT = Number(process.env.PORT ?? 3000);
const ALLOW_SEND = (process.env.ALLOW_SEND ?? "true") === "true";

/** imapflow throws a bare "Command failed"; surface the server's actual answer. */
function describeError(e: unknown): string {
  const err = e as Error & { responseText?: string; authenticationFailed?: boolean; serverResponseCode?: string; code?: string };
  const parts = [err.message];
  if (err.authenticationFailed)
    parts.push("Anmeldung bei web.de fehlgeschlagen – IMAP-Zugriff in den web.de-Einstellungen aktiviert? Passwort/App-Passwort korrekt?");
  if (err.serverResponseCode) parts.push(`Code: ${err.serverResponseCode}`);
  if (err.responseText) parts.push(`Server: ${err.responseText}`);
  if (err.code) parts.push(`(${err.code})`);
  console.error("[tool error]", parts.join(" | "));
  return parts.join(" | ");
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const wrap =
  <A>(fn: (a: A) => Promise<unknown>) =>
  async (a: A) => {
    try {
      return json(await fn(a));
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: `Fehler: ${describeError(e)}` }] };
    }
  };

function buildServer() {
  const s = new McpServer({ name: "webde-mail", version: "1.0.0" });

  s.registerTool(
    "list_folders",
    { description: "Listet alle Ordner des web.de-Postfachs mit Anzahl (ungelesener) Mails.", inputSchema: {} },
    wrap(async () => mail.listFolders()),
  );

  s.registerTool(
    "search_emails",
    {
      description: "Durchsucht einen Ordner (Standard: INBOX). Liefert Kopfdaten, neueste zuerst.",
      inputSchema: {
        folder: z.string().default("INBOX"),
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        text: z.string().optional().describe("Volltextsuche im Body"),
        since: z.string().optional().describe("ISO-Datum, z.B. 2026-11-01"),
        before: z.string().optional(),
        unseen: z.boolean().optional().describe("Nur ungelesene"),
        limit: z.number().int().min(1).max(200).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    wrap((a: mail.SearchArgs) => mail.searchEmails(a)),
  );

  s.registerTool(
    "get_email",
    {
      description: "Liest eine Mail vollständig (Text, Empfänger, Anhänge-Liste) anhand der UID.",
      inputSchema: {
        folder: z.string().default("INBOX"),
        uid: z.number().int(),
        max_chars: z.number().int().default(20000),
      },
      annotations: { readOnlyHint: true },
    },
    wrap((a: { folder: string; uid: number; max_chars: number }) => mail.getEmail(a.folder, a.uid, a.max_chars)),
  );

  s.registerTool(
    "mark_emails",
    {
      description: "Markiert Mails als gelesen oder ungelesen.",
      inputSchema: { folder: z.string().default("INBOX"), uids: z.array(z.number().int()).min(1), seen: z.boolean() },
    },
    wrap((a: { folder: string; uids: number[]; seen: boolean }) => mail.setFlags(a.folder, a.uids, a.seen)),
  );

  s.registerTool(
    "move_emails",
    {
      description: "Verschiebt Mails in einen anderen Ordner (z.B. 'Papierkorb', 'Spam', eigene Ordner).",
      inputSchema: {
        folder: z.string().default("INBOX"),
        uids: z.array(z.number().int()).min(1),
        target: z.string(),
      },
      annotations: { destructiveHint: true },
    },
    wrap((a: { folder: string; uids: number[]; target: string }) => mail.moveEmails(a.folder, a.uids, a.target)),
  );

  const sendSchema = {
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    subject: z.string(),
    text: z.string(),
    html: z.string().optional(),
  };

  s.registerTool(
    "save_draft",
    { description: "Legt eine Mail als Entwurf im web.de-Ordner 'Entwürfe' ab (wird NICHT versendet).", inputSchema: sendSchema },
    wrap((a: mail.SendArgs) => mail.saveDraft(a)),
  );

  if (ALLOW_SEND) {
    s.registerTool(
      "send_email",
      {
        description: "Versendet eine Mail über web.de SMTP und legt eine Kopie in 'Gesendet' ab.",
        inputSchema: { ...sendSchema, in_reply_to: z.string().optional().describe("Message-ID der beantworteten Mail") },
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      wrap((a: mail.SendArgs & { in_reply_to?: string }) => mail.sendEmail({ ...a, inReplyTo: a.in_reply_to })),
    );
  }

  return s;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

function auth(req: Request, res: Response, next: NextFunction) {
  const h = req.header("authorization") ?? "";
  const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(TOKEN);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", auth, async (req, res) => {
  const sid = req.header("mcp-session-id");
  let t = sid ? transports[sid] : undefined;

  if (!t) {
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null });
      return;
    }
    t = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = t!;
      },
    });
    t.onclose = () => {
      if (t!.sessionId) delete transports[t!.sessionId];
    };
    await buildServer().connect(t);
  }
  await t.handleRequest(req, res, req.body);
});

const bySession = async (req: Request, res: Response) => {
  const sid = req.header("mcp-session-id");
  const t = sid ? transports[sid] : undefined;
  if (!t) {
    res.status(400).send("Invalid or missing session");
    return;
  }
  await t.handleRequest(req, res);
};
app.get("/mcp", auth, bySession);
app.delete("/mcp", auth, bySession);

app.listen(PORT, () => console.log(`webde-mcp listening on :${PORT} (send ${ALLOW_SEND ? "enabled" : "disabled"})`));
