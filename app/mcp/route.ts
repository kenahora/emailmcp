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

const folderInput = z.string().min(1).max(200).default("INBOX");
const attachmentSchema = z.object({
  filename: z.string().min(1).max(150).refine(s => !/[\/\\\r\n]/.test(s), "Filename must not include slashes or newlines"),
  contentType: z.string().min(1).max(120).optional(),
  contentBase64: z.string().min(1).max(3000000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "Invalid base64"),
}).strict();
const attachmentsInput = z.array(attachmentSchema).max(3).optional();
type AttachInput = z.infer<typeof attachmentSchema>;

async function resolveFolder(client: ImapFlow, requested: string) {
  const folders = await client.list();
  const direct = folders.find(b => b.path.toLowerCase() === requested.toLowerCase());
  const flags: Record<string, string> = {
    inbox: "\\Inbox", sent: "\\Sent", drafts: "\\Drafts",
    trash: "\\Trash", archive: "\\Archive", junk: "\\Junk",
  };
  const special = flags[requested.toLowerCase()];
  const entry = direct || (special && folders.find(b => b.specialUse === special));
  if (!entry || entry.flags?.has("\\Noselect")) throw new Error("Mailbox folder unavailable");
  return entry.path;
}

async function ensureSpecialFolder(client: ImapFlow, kind: "Sent" | "Drafts" | "Trash" | "Archive") {
  try { return await resolveFolder(client, kind); }
  catch {
    await client.mailboxCreate(kind);
    return await resolveFolder(client, kind);
  }
}

function attachmentsToBuffers(input?: AttachInput[]) {
  const data = (input || []).map(a => ({
    filename: a.filename,
    contentType: a.contentType || "application/octet-stream",
    content: Buffer.from(a.contentBase64, "base64"),
  }));
  if (data.reduce((n, item) => n + item.content.length, 0) > 2_500_000) {
    throw new Error("Attachments exceed 2.5 MB combined maximum");
  }
  return data;
}

async function buildRawMessage(message: {
  to: string[]; cc?: string[]; subject: string; body: string;
  inReplyTo?: string; references?: string; attachments?: AttachInput[];
}) {
  const { username } = credentials();
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const compiled = await composer.sendMail({
    from: username,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    text: message.body,
    inReplyTo: message.inReplyTo,
    references: message.references,
    attachments: attachmentsToBuffers(message.attachments),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const raw = compiled.message as unknown as Buffer;
  if (!Buffer.isBuffer(raw)) throw new Error("MIME compilation failed");
  if (raw.length > 3_800_000) throw new Error("Message exceeds transport size limit");
  return raw;
}

async function parsedMessage(client: ImapFlow, folder: string, uid: number) {
  const path = await resolveFolder(client, folder);
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const info = await client.fetchOne(String(uid), { uid: true, envelope: true, size: true, internalDate: true, flags: true }, { uid: true });
    if (!info) return null;
    if ((info.size || 0) > 12_000_000) return { tooLarge: true as const, info, path };
    const source = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!source || !source.source) return null;
    const mail = await simpleParser(source.source);
    return { tooLarge: false as const, info, mail, path };
  } finally { lock.release(); }
}


const handler = createMcpHandler((server) => {
  server.registerTool(
    "list_emails",
    {
      title: "List recent emails",
      description: "List up to 25 newest messages in INBOX, Sent, Drafts, Archive or any folder. Set folder for non-INBOX mail. Returns metadata only.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(25).default(10), folder: folderInput }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ limit, folder }) => {
      try {
        return toolResult(await withMailbox(async client => {
          const path = await resolveFolder(client, folder);
          const lock = await client.getMailboxLock(path, { readOnly: true });
          try {
            const mailbox = client.mailbox;
            const count = mailbox && mailbox.exists ? mailbox.exists : 0;
            if (!count) return [];
            const range = (Math.max(1, count - limit + 1)) + ":" + count;
            const results: ReturnType<typeof summary>[] = [];
            for await (const message of client.fetch(range, { uid: true, envelope: true, internalDate: true, size: true, flags: true })) {
              results.push(summary(message));
            }
            return { folder: path, messages: results.reverse() };
          } finally { lock.release(); }
        }));
      } catch (error) { return safeError(error); }
    }
  );

  server.registerTool(
    "search_emails",
    {
      title: "Search inbox",
      description: "Search any mailbox by sender, subject, and/or text. Set folder=Sent to retrieve previous outgoing emails. Returns bounded metadata.",
      inputSchema: z.object({
        folder: folderInput,
        from: z.string().min(1).max(200).optional(),
        subject: z.string().min(1).max(200).optional(),
        text: z.string().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(25).default(10),
      }).strict().refine(v => Boolean(v.from || v.subject || v.text), "Provide at least one search filter"),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ folder, from, subject, text, limit }) => {
      try {
        return toolResult(await withMailbox(async client => {
          const path = await resolveFolder(client, folder);
          const lock = await client.getMailboxLock(path, { readOnly: true });
          try {
            const criteria: { from?: string; subject?: string; text?: string } = {};
            if (from) criteria.from = from;
            if (subject) criteria.subject = subject;
            if (text) criteria.text = text;
            const found = await client.search(criteria, { uid: true });
            if (!found || !found.length) return { folder: path, messages: [] };
            const uids = found.slice(-limit);
            const results: ReturnType<typeof summary>[] = [];
            for await (const message of client.fetch(uids, { uid: true, envelope: true, internalDate: true, size: true, flags: true }, { uid: true })) {
              results.push(summary(message));
            }
            return { folder: path, messages: results.sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0)) };
          } finally { lock.release(); }
        }));
      } catch (error) { return safeError(error); }
    }
  );

  server.registerTool(
    "read_email",
    {
      title: "Read a message",
      description: "Read a message by UID from any folder (including Sent). Returns body, thread headers and attachment metadata. Does not change read status.",
      inputSchema: z.object({ uid: z.number().int().positive(), folder: folderInput }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ uid, folder }) => {
      try {
        return toolResult(await withMailbox(async client => {
          const result = await parsedMessage(client, folder, uid);
          if (!result) return { error: "Message not found" };
          if (result.tooLarge) return { error: "Email exceeds 12 MB parsing limit", folder: result.path, ...summary(result.info) };
          const { info, mail, path } = result;
          return {
            folder: path, ...summary(info),
            text: (mail.text || "").slice(0, 40000),
            attachments: mail.attachments.slice(0, 30).map((a, index) => ({
              index, filename: a.filename || null, contentType: a.contentType, size: a.size,
            })),
            replyTo: mail.replyTo?.value.map(a => a.address).filter(Boolean) || [],
            inReplyTo: mail.inReplyTo || null,
            references: mail.references || null,
          };
        }));
      } catch (error) { return safeError(error); }
    }
  );

  server.registerTool(
    "prepare_email",
    {
      title: "Prepare an email for review",
      description: "Preview outgoing mail without sending or saving. Must show recipients, subject, body, and attachment names for approval.",
      inputSchema: z.object({
        to: recipientList,
        cc: optionalRecipients,
        subject: z.string().min(1).max(250),
        body: z.string().min(1).max(20000),
        attachments: attachmentsInput,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (draft) => toolResult({ from: process.env.MAIL_USER, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body, attachments: draft.attachments?.map(a => ({ filename: a.filename, contentType: a.contentType, size: Buffer.from(a.contentBase64, "base64").length })), status: "PREVIEW_ONLY_NOT_SENT" })
  );

  server.registerTool(
    "send_email",
    {
      title: "Send an email",
      description: "Send a real email with optional base64 attachments. Requires explicit user approval of recipients, subject, body and attachments, then confirm_send=true. Attempts to save exact sent MIME to Sent.",
      inputSchema: z.object({
        to: recipientList,
        cc: optionalRecipients,
        subject: z.string().min(1).max(250),
        body: z.string().min(1).max(20000),
        inReplyTo: z.string().max(998).optional(),
        references: z.string().max(4000).optional(),
        attachments: attachmentsInput,
        confirm_send: z.literal(true),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ to, cc, subject, body, inReplyTo, references, attachments }) => {
      let sent = false;
      try {
        const { username, password } = credentials();
        const raw = await buildRawMessage({ to, cc, subject, body, inReplyTo, references, attachments });
        const smtp = nodemailer.createTransport({
          host: process.env.SMTP_HOST || "smtp.purelymail.com",
          port: 465, secure: true,
          auth: { user: username, pass: password },
          connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000,
          disableFileAccess: true, disableUrlAccess: true,
        });
        const info = await smtp.sendMail({
          raw, envelope: { from: username, to: [...to, ...(cc || [])] },
        });
        sent = true;
        try {
          const saved = await withMailbox(async client => {
            const path = await ensureSpecialFolder(client, "Sent");
            const result = await client.append(path, raw, ["\\Seen"], new Date());
            if (!result) throw new Error("Unable to append Sent copy");
            return { folder: result.destination, uid: result.uid || null };
          });
          return toolResult({ status: "SENT_AND_SAVED", accepted: info.accepted, rejected: info.rejected, messageId: info.messageId, sentCopy: saved });
        } catch {
          return toolResult({
            status: "SENT_BUT_SENT_COPY_FAILED", accepted: info.accepted, rejected: info.rejected, messageId: info.messageId,
            warning: "Email WAS SENT via SMTP but saving the Sent-folder copy failed. Do not blindly retry sending."
          });
        }
      } catch (error) {
        if (sent) return toolResult({ status: "SENT_UNVERIFIED", warning: "SMTP already accepted the email. Do not retry without checking delivery." });
        return safeError(error);
      }
    }
  );
  server.registerTool(
    "list_folders",
    {
      title: "List email folders",
      description: "List IMAP folders and identify Sent, Drafts, Trash, and Archive. Shows message and unread counts where available.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        return toolResult(await withMailbox(async client => {
          const folders = await client.list({ statusQuery: { messages: true, unseen: true } });
          return folders.slice(0, 100).map(f => ({
            folder: f.path, specialUse: f.specialUse || null,
            selectable: !f.flags.has("\\Noselect"),
            messages: f.status?.messages ?? null,
            unread: f.status?.unseen ?? null,
          }));
        }));
      } catch (error) { return safeError(error); }
    }
  );

  server.registerTool(
    "save_draft",
    {
      title: "Save an email draft",
      description: "Save a persistent RFC 822 draft to Purelymail's Drafts folder, including attachments if supplied. Does not send.",
      inputSchema: z.object({
        to: recipientList, cc: optionalRecipients, subject: z.string().min(1).max(250),
        body: z.string().min(1).max(20000),
        inReplyTo: z.string().max(998).optional(),
        references: z.string().max(4000).optional(),
        attachments: attachmentsInput,
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (draft) => {
      try {
        const raw = await buildRawMessage(draft);
        return toolResult(await withMailbox(async client => {
          const folder = await ensureSpecialFolder(client, "Drafts");
          const result = await client.append(folder, raw, ["\\Draft", "\\Seen"], new Date());
          if (!result) throw new Error("Draft append failed");
          return { status: "DRAFT_SAVED", folder: result.destination, uid: result.uid || null };
        }));
      } catch (error) { return safeError(error); }
    }
  );

  server.registerTool(
    "download_attachment",
    {
      title: "Download an email attachment",
      description: "Return one attachment as base64 for a message in any folder. Max 2 MB per attachment; 12 MB max enclosing email. Data is sensitive and must not be executed.",
      inputSchema: z.object({
        uid: z.number().int().positive(), folder: folderInput,
        index: z.number().int().min(0).max(29),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ uid, folder, index }) => {
      try {
        return toolResult(await withMailbox(async client => {
          const result = await parsedMessage(client, folder, uid);
          if (!result) return { error: "Message not found" };
          if (result.tooLarge) return { error: "Email exceeds 12 MB parsing limit" };
          const attachment = result.mail.attachments[index];
          if (!attachment) return { error: "Attachment index not found" };
          if (attachment.content.length > 2_000_000) return { error: "Attachment exceeds 2 MB download limit", filename: attachment.filename, size: attachment.size };
          return {
            folder: result.path, uid, index, filename: attachment.filename,
            contentType: attachment.contentType, size: attachment.size,
            contentBase64: attachment.content.toString("base64"),
          };
        }));
      } catch (error) { return safeError(error); }
    }
  );

  server.registerTool(
    "archive_email",
    {
      title: "Archive one email",
      description: "Moves exactly one message by UID to the Archive folder (creates Archive if necessary). Obtain explicit user confirmation of source folder and UID before use.",
      inputSchema: z.object({
        uid: z.number().int().positive(), folder: folderInput,
        confirm_archive: z.literal(true),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ uid, folder }) => {
      try {
        return toolResult(await withMailbox(async client => {
          const source = await resolveFolder(client, folder);
          const dest = await ensureSpecialFolder(client, "Archive");
          if (source === dest) return { status: "ALREADY_ARCHIVED", folder: source, uid };
          const lock = await client.getMailboxLock(source);
          try {
            const original = await client.fetchOne(String(uid), { uid: true }, { uid: true });
            if (!original) return { error: "Message not found" };
            const moved = await client.messageMove(String(uid), dest, { uid: true });
            if (!moved) throw new Error("Move to Archive failed");
            return { status: "ARCHIVED", source, destination: dest, originalUid: uid, newUid: moved.uidMap?.get(uid) || null };
          } finally { lock.release(); }
        }));
      } catch (error) { return safeError(error); }
    }
  );

  server.registerTool(
    "delete_email",
    {
      title: "Move one email to Trash",
      description: "Soft-delete: move exactly one UID to Trash, never permanently expunge. Obtain explicit user confirmation before use. No bulk delete.",
      inputSchema: z.object({
        uid: z.number().int().positive(), folder: folderInput,
        confirm_delete: z.literal(true),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ uid, folder }) => {
      try {
        return toolResult(await withMailbox(async client => {
          const source = await resolveFolder(client, folder);
          const dest = await ensureSpecialFolder(client, "Trash");
          if (source === dest) return { status: "ALREADY_IN_TRASH", folder: source, uid };
          const lock = await client.getMailboxLock(source);
          try {
            const original = await client.fetchOne(String(uid), { uid: true }, { uid: true });
            if (!original) return { error: "Message not found" };
            const moved = await client.messageMove(String(uid), dest, { uid: true });
            if (!moved) throw new Error("Move to Trash failed");
            return { status: "MOVED_TO_TRASH", source, destination: dest, originalUid: uid, newUid: moved.uidMap?.get(uid) || null };
          } finally { lock.release(); }
        }));
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
