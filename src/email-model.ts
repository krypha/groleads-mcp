/** Keep a text-only email creation compatible with the API's required HTML body.
 * Explicit HTML and AI/template-editor payloads remain untouched.
 */
export const MAX_EMAIL_HTML_LENGTH = 250_000;

export function textToEmailHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\r\n|\r|\n/g, "<br>");
  const html = `<p>${escaped}</p>`;
  if (html.length > MAX_EMAIL_HTML_LENGTH) {
    throw new Error("Generated HTML exceeds 250000 characters. Shorten the text or supply an explicit HTML body.");
  }
  return html;
}

export function normalizeEmailCreation(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const input = body as Record<string, unknown>;
  // Preserve advanced creation semantics rather than guessing their content.
  const hasEditorTemplate = typeof input.json_template === "string"
    ? input.json_template.trim().length > 0 : input.json_template !== undefined && input.json_template !== null;
  if (input.is_ai === true || input.is_template === true || hasEditorTemplate) return body;
  const missingHtml = input.html === undefined || input.html === null ||
    (typeof input.html === "string" && !input.html.trim());
  if (!missingHtml || typeof input.text !== "string" || !input.text.trim()) return body;
  return { ...input, html: textToEmailHtml(input.text) };
}
