import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 60;

type EnvelopeAddress = { name?: string; address?: string };

function credentials() {
  const username = process.env.MAIL_USER;
  const password = process.env.MAIL_PASSWORD;
  if (!username || !password) {
    throw new Error("Purelymail credentials are not configured.");
  }
  return { username, password };
}

async function withMailbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const { username, password } = credentials();
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.purelymail.com",
    port: 993,
    secure: true,
    auth: { user: username, pass: password },
    logger: false,
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

function addresses(input: EnvelopeAddress[] | undefined) {
  return (input || []).map(a => a.address || "").filter(Boolean);
}

function summary(message: {
  uid?: number;
  envelope?: {
    subject?: string;
    from?: EnvelopeAddress[];
    to?: EnvelopeAddress[];
    date?: Date | string;
    messageId?: string;
  };
  internalDate?: Date | string;
  size?: number;
  flags?: Set<string>;
}) {
  return {
    uid: message.uid ?? null,
    subject: message.envelope?.subject || "(no subject)",
    from: addresses(message.envelope?.from),
    to: addresses(message.envelope?.to),
    date: (message.internalDate ? new Date(message.internalDate).toISOString() : null) || (message.envelope?.date ? new Date(message.envelope.date).toISOString() : null),
    messageId: message.envelope?.messageId || null,
    size: message.size ?? null,
    seen: message.flags?.has("\\Seen") ?? false,
  };
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function safeError(error: unknown) {
  // Never return protocol errors or connection details to the language model.
  console.error("Mail tool operation failed:", error instanceof Error ? error.name : "unknown");
  return { content: [{ type: "text" as const, text: "The mail operation failed. Check server configuration or retry." }], isError: true };
}

const emailAddress = z.string().email().max(254);
const recipientList = z.array(emailAddress).min(1).max(5);
const optionalRecipients = z.array(emailAddress).max(5).optional();

const handler = createMcpHandler((server) => {
  server.registerTool(
    "list_emails",
    {
      title: "List recent emails",
      description: "List up to 25 newest messages in the INBOX. Returns metadata only, not bodies.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(25).default(10) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ limit }) => {
      try {
        return toolResult(await withMailbox(async client => {
          const lock = await client.getMailboxLock("INBOX");
          try {
            const mailbox = client.mailbox;
            const count = mailbox && mailbox.exists ? mailbox.exists : 0;
            if (!count) return [];
            const range = (Math.max(1, count - limit + 1)) + ":" + count;
            const results: ReturnType<typeof summary>[] = [];
            for await (const message of client.fetch(range, { uid: true, envelope: true, internalDate: true, size: true, flags: true })) {
              results.push(summary(message));
            }
            return results.reverse();
          } finally { lock.release(); }
        }));
      } catch (error) { return safeError(error); }
    }
  );

  server.registerTool(
    "search_emails",
    {
      title: "Search inbox",
      description: "Search messages in the INBOX by sender, subject, and/or text. Returns the 25 most recent matching messages as metadata only.",
      inputSchema: z.object({
        from: z.string().min(1).max(200).optional(),
        subject: z.string().min(1).max(200).optional(),
        text: z.string().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(25).default(10),
      }).strict().refine(v => Boolean(v.from || v.subject || v.text), "Provide at least one search filter"),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ from, subject, text, limit }) => {
      try {
        return toolResult(await withMailbox(async client => {
          const lock = await client.getMailboxLock("INBOX");
          try {
            const criteria: { from?: string; subject?: string; text?: string } = {};
            if (from) criteria.from = from;
            if (subject) criteria.subject = subject;
            if (text) criteria.text = text;
            const found = await client.search(criteria, { uid: true });
            if (!found || !found.length) return [];
            const uids = found.slice(-limit);
            const results: ReturnType<typeof summary>[] = [];
            for await (const message of client.fetch(uids, { uid: true, envelope: true, internalDate: true, size: true, flags: true }, { uid: true })) {
              results.push(summary(message));
            }
            return results.sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0));
          } finally { lock.release(); }
        }));
      } catch (error) { return safeError(error); }
    }
  );

  server.registerTool(
    "read_email",
    {
      title: "Read a message",
      description: "Read the text body of one INBOX email by IMAP UID. Does not change its read/unread status or download attachments.",
      inputSchema: z.object({ uid: z.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ uid }) => {
      try {
        return toolResult(await withMailbox(async client => {
          const lock = await client.getMailboxLock("INBOX");
          try {
            const metadata = await client.fetchOne(String(uid), { uid: true, envelope: true, size: true, internalDate: true, flags: true }, { uid: true });
            if (!metadata) return { error: "Message not found" };
            // Refuse oversized messages instead of unexpectedly pulling their attachments into memory.
            if ((metadata.size ?? 0) > 2_000_000) return { error: "Message exceeds 2 MB size limit", ...summary(metadata) };
            const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!full || !full.source) return { error: "Message not found" };
            const parsed = await simpleParser(full.source);
            return {
              ...summary(metadata),
              text: (parsed.text || "").slice(0, 40000),
              attachments: parsed.attachments.map(a => ({ filename: a.filename || null, contentType: a.contentType, size: a.size })).slice(0, 30),
              replyTo: parsed.replyTo?.value.map(a => a.address).filter(Boolean) || [],
              inReplyTo: parsed.inReplyTo || null,
            };
          } finally { lock.release(); }
        }));
      } catch (error) { return safeError(error); }
    }
  );

  server.registerTool(
    "prepare_email",
    {
      title: "Prepare an email for review",
      description: "Preview an outgoing message. Does not send or save the email. Always show this preview to the user before requesting send_email.",
      inputSchema: z.object({
        to: recipientList,
        cc: optionalRecipients,
        subject: z.string().min(1).max(250),
        body: z.string().min(1).max(20000),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (draft) => toolResult({ from: process.env.MAIL_USER, ...draft, status: "PREVIEW_ONLY_NOT_SENT" })
  );

  server.registerTool(
    "send_email",
    {
      title: "Send an email",
      description: "Sends a real email via Purelymail. Only call after the user explicitly approves the exact recipients, subject, and body. Requires confirm_send=true.",
      inputSchema: z.object({
        to: recipientList,
        cc: optionalRecipients,
        subject: z.string().min(1).max(250),
        body: z.string().min(1).max(20000),
        inReplyTo: z.string().max(998).optional(),
        references: z.string().max(4000).optional(),
        confirm_send: z.literal(true),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ to, cc, subject, body, inReplyTo, references }) => {
      try {
        const { username, password } = credentials();
        const smtp = nodemailer.createTransport({
          host: process.env.SMTP_HOST || "smtp.purelymail.com",
          port: 465,
          secure: true,
          auth: { user: username, pass: password },
          connectionTimeout: 12000,
          greetingTimeout: 12000,
          socketTimeout: 20000,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        const info = await smtp.sendMail({
          from: username,
          to,
          cc,
          subject,
          text: body,
          ...(inReplyTo ? { inReplyTo } : {}),
          ...(references ? { references } : {}),
        });
        return toolResult({ status: "SENT", accepted: info.accepted, rejected: info.rejected, messageId: info.messageId });
      } catch (error) { return safeError(error); }
    }
  );
});

function authorize(request: Request): Response | null {
  const secret = process.env.MCP_API_KEY;
  if (!secret || secret.length < 32) {
    return new Response("Server authentication is not configured", { status: 503 });
  }
  const bearer = request.headers.get("authorization") || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
  const expected = Buffer.from(secret, "utf8");
  const provided = Buffer.from(token, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="Purelymail MCP"' } });
  }
  return null;
}

async function protectedHandler(request: Request): Promise<Response> {
  const denial = authorize(request);
  if (denial) return denial;
  return handler(request);
}

export const GET = protectedHandler;
export const POST = protectedHandler;
export const DELETE = protectedHandler;
