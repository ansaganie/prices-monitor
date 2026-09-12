// Telegram Bot API sender. Throws on any non-OK response so misconfigured
// secrets fail the Action loudly instead of silently dropping alerts.

const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/** Escape the three characters Telegram's HTML parse mode treats as markup. */
export function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Split on blank lines so a long alert never exceeds Telegram's per-message cap. */
function splitIntoChunks(text, limit = TELEGRAM_MAX_MESSAGE_CHARS) {
  const chunks = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };

  for (const block of text.split("\n\n")) {
    if (block.length > limit) {
      // A single block over the limit is hard-sliced rather than dropped.
      flush();
      for (let i = 0; i < block.length; i += limit) chunks.push(block.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      flush();
      current = block;
    }
  }
  flush();

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Send a message (HTML parse mode), chunked if needed.
 * Set DRY_RUN=1 to print to stdout instead of sending.
 */
export async function sendMessage(text) {
  if (process.env.DRY_RUN === "1") {
    console.log("--- DRY_RUN, message not sent ---\n" + text + "\n--- end ---");
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set");
  }

  for (const chunk of splitIntoChunks(text)) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      // Surface Telegram's own description ("chat not found", "Unauthorized", …)
      // — the response body is far more useful than the status code alone.
      const detail = await res.text().catch(() => "");
      throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${res.statusText} ${detail}`.trim());
    }
  }
}
