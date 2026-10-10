/**
 * agent_mail.mjs — the agent's OWN inbox. No human email account involved.
 *
 * Identity: your-inbox@agentmail.to (set AGENTMAIL_INBOX)
 * Auth:     AGENTMAIL_API_KEY (inbox-scoped key, lowercase "am_us_inbox_...")
 *
 * IMPORTANT: an inbox-scoped key can only touch its own inbox. Org-level
 * endpoints (inboxes.list) return 403 by design. auth/me still works.
 * The key prefix MUST be lowercase "am_" — "Am_" is rejected with 403.
 *
 * Usage:
 *   node agent_mail.mjs me
 *   node agent_mail.mjs inbox
 *   node agent_mail.mjs messages [limit]
 *   node agent_mail.mjs send <to> <subject> <body>
 *   node agent_mail.mjs reply <message_id> <body>
 */
import { AgentMailClient } from "agentmail";

const KEY = process.env.AGENTMAIL_API_KEY;
const INBOX = process.env.AGENTMAIL_INBOX || "your-inbox@agentmail.to";

if (!KEY) {
  console.error("AGENTMAIL_API_KEY not set (see $HERMES_HOME/.env)");
  process.exit(1);
}
if (KEY.startsWith("Am_")) {
  console.error("Key prefix must be lowercase 'am_' — 'Am_' is rejected with 403.");
  process.exit(1);
}

const client = new AgentMailClient({ apiKey: KEY });
const [cmd, ...args] = process.argv.slice(2);

async function whoami() {
  const r = await fetch("https://api.agentmail.to/v0/auth/me", {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  console.log(JSON.stringify(await r.json(), null, 2));
}

async function getInbox() {
  const i = await client.inboxes.get(INBOX);
  console.log(`inbox:  ${i.email}`);
  console.log(`org:    ${i.organizationId ?? i.organization_id}`);
  console.log(`status: active until ${i.statusUntil ?? i.status_until ?? "?"}`);
}

async function listMessages(limit = 20) {
  const res = await client.inboxes.messages.list(INBOX, { limit });
  const msgs = res.messages ?? [];
  console.log(`${res.count ?? msgs.length} message(s):`);
  for (const m of msgs) {
    console.log(`  [${m.timestamp}] ${m.from}`);
    console.log(`      ${m.subject}`);
  }
}

async function send(to, subject, body) {
  const r = await client.inboxes.messages.send(INBOX, { to, subject, text: body });
  console.log("sent:", r.messageId ?? r.message_id, "| thread:", r.threadId ?? r.thread_id);
}

async function reply(messageId, body) {
  const r = await client.inboxes.messages.reply(INBOX, messageId, { text: body });
  console.log("replied:", r.messageId ?? r.message_id);
}

try {
  switch (cmd) {
    case "me":       await whoami(); break;
    case "inbox":    await getInbox(); break;
    case "messages": await listMessages(Number(args[0]) || 20); break;
    case "send":     await send(args[0], args[1], args.slice(2).join(" ")); break;
    case "reply":    await reply(args[0], args.slice(1).join(" ")); break;
    default:
      console.log("usage: node agent_mail.mjs <me|inbox|messages|send|reply> [args]");
  }
} catch (e) {
  console.error("error:", e.status ?? "", e.body?.message ?? e.message);
  process.exit(1);
}
