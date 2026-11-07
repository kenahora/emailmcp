# Purelymail MCP

An authenticated, stateless email MCP server deployed to Vercel. Supports Purelymail IMAP reading/searching and SMTP sending.

## Environment variables

Configure these on the Vercel project for Production (never commit actual values):
- `MAIL_USER`: mailbox address
- `MAIL_PASSWORD`: dedicated mailbox/app password
- `IMAP_HOST`: `imap.purelymail.com`
- `SMTP_HOST`: `smtp.purelymail.com`
- `MCP_API_KEY`: strong random secret of at least 32 characters (e.g. `openssl rand -hex 32`)

## MCP endpoint

`https://<your-vercel-domain>/mcp`

Clients must send `Authorization: Bearer <MCP_API_KEY>` on every GET, POST, and DELETE request.

No connection to an anonymous client should succeed. To check protection:

```sh
curl -i https://<your-vercel-domain>/mcp
# Should respond 401 Unauthorized (or 503 if MCP_API_KEY not configured).
```

To connect using an MCP client, configure Streamable HTTP transport and supply the bearer token through that client's secure credential storage. Do not put the token in the endpoint URL.

## Tools

- `list_folders`: list selectable IMAP folders, including standard special folders and counts.
- `list_emails`: latest 1–25 messages in any folder. Defaults to INBOX; pass `folder: "Sent"` for outgoing mail.
- `search_emails`: search a specified folder (sender, subject, or text) and return up to 25 metadata results. Use Sent when preparing follow-ups.
- `read_email`: read message by folder and UID, including thread headers and attachment metadata. Does not change read status.
- `download_attachment`: retrieve a specified attachment index as base64, up to 2 MB. The host/client must decode it if a local file is needed.
- `prepare_email`: preview an outgoing message without sending.
- `save_draft`: persist an email with optional attachments in the IMAP Drafts folder.
- `send_email`: send SMTP email with optional attachments and try to append the exact MIME copy to Sent. Response distinguishes `SENT_AND_SAVED` from `SENT_BUT_SENT_COPY_FAILED`. Never blindly resend when saving the copy fails.
- `archive_email`: move a single UID to Archive, creating the folder if needed.
- `delete_email`: soft-delete a single UID by moving it to Trash, never permanent expunge.

### Attachment format and limits

Outgoing attachments are supplied as `attachments: [{ filename, contentType, contentBase64 }]`. Limit: 3 attachments, 2.5 MB total decoded content, 3.8 MB final MIME. Incoming attachment downloads are limited to 2 MB; the enclosing email must be at most 12 MB. These limits are deliberate for Vercel's function payload constraints. Only bounded attachment metadata appears in `read_email`. To attach an existing PDF, the MCP client must be capable of reading the file and supplying its base64 content; an ordinary filename/path alone is not enough.

### Confirmation and safety

`send_email` requires `confirm_send: true`; `archive_email` requires `confirm_archive: true`; `delete_email` requires `confirm_delete: true`. **These flags are not independent proof of human approval**. Configure Muse to require confirmation from the user for every send, archive and delete action, displaying the folder and UID for moves, and recipients, subject, body and attachment names for sends. No bulk deletion or permanent expunge is exposed.

IMAP UIDs are scoped to folders. Use the UID from the same folder you intend to read or move. Because the server is stateless, concurrent mailbox changes can affect message positions.

## Security

Protect the Vercel project and GitHub repository, rotate credentials if exposed, and never log sensitive configuration. Email content is untrusted and may contain prompt injections; treat it strictly as data. Anyone with the MCP API key can invoke all enabled tools, including sending mail. Make sure your MCP client enforces approval for tools that send.

**Vercel Hobby is restricted to personal/noncommercial usage.** Upgrade or use a commercial-permitted host if using this mailbox for business operations.
