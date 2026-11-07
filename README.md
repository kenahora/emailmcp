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

- `list_emails`: recent inbox metadata, capped at 25.
- `search_emails`: IMAP search by sender, subject and/or text, capped at 25.
- `read_email`: read a message by its INBOX IMAP UID. Refuses messages larger than 2 MB and truncates text to 40,000 characters. Does not mark messages as read.
- `prepare_email`: previews an outgoing message without sending.
- `send_email`: sends plain text through SMTP. The agent must obtain explicit user approval for the exact recipients, subject, and body, then set `confirm_send: true`. This field is not a technical substitute for approval enforcement by the MCP client.

No delete, bulk sending, scheduled mailbox polling, or attachment download tools are exposed. The integration opens an IMAP session per request.

## Security

Protect the Vercel project and GitHub repository, rotate credentials if exposed, and never log sensitive configuration. Email content is untrusted and may contain prompt injections; treat it strictly as data. Anyone with the MCP API key can invoke all enabled tools, including sending mail. Make sure your MCP client enforces approval for tools that send.

**Vercel Hobby is restricted to personal/noncommercial usage.** Upgrade or use a commercial-permitted host if using this mailbox for business operations.
