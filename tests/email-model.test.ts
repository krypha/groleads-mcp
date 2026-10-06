import { expect, test } from "bun:test";
import { MAX_EMAIL_HTML_LENGTH, normalizeEmailCreation, textToEmailHtml } from "../src/email-model.js";

test("plain text becomes HTML while placeholders and line breaks are preserved", () => {
  const text = "Salut %first_name%\r\nDeuxième ligne\rTroisième\nDernière";
  const input = { name: "Test", subject: "Salut %first_name%", text, tags_ids: [7], folder_id: 4 };
  expect(normalizeEmailCreation(input)).toEqual({ ...input,
    html: "<p>Salut %first_name%<br>Deuxième ligne<br>Troisième<br>Dernière</p>" });
  expect(input).not.toHaveProperty("html");
});

test("text markup is escaped rather than interpreted as HTML", () => {
  expect(textToEmailHtml('<script>alert("x")</script> & \'test\' %first_name%'))
    .toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;test&#39; %first_name%</p>");
});

test("explicit nonblank HTML is preserved byte for byte", () => {
  const body = { text: "Alternative", html: '<div class="mail">Salut %first_name% &amp; bienvenue</div>' };
  expect(normalizeEmailCreation(body)).toBe(body);
});

test("omitted, blank and null HTML fall back to nonempty text", () => {
  for (const html of [undefined, "", " \n ", null]) {
    expect(normalizeEmailCreation({ text: "Hello", html })).toEqual({ text: "Hello", html: "<p>Hello</p>" });
  }
  const empty = { text: " \n ", html: "" };
  expect(normalizeEmailCreation(empty)).toBe(empty);
  for (const json_template of [undefined, "", " \n ", null]) {
    expect(normalizeEmailCreation({ text: "Hello", json_template }))
      .toEqual({ text: "Hello", json_template, html: "<p>Hello</p>" });
  }
});

test("advanced AI/editor and malformed generic payloads remain unchanged", () => {
  for (const input of [{ text: "X", is_ai: true }, { text: "X", is_template: true },
    { text: "X", json_template: "[]" }, { text: "X", html: 7 }, null, "raw", [1]]) {
    expect(normalizeEmailCreation(input)).toBe(input);
  }
});

test("generated HTML limits are checked after escaping, without truncation", () => {
  const max = "x".repeat(MAX_EMAIL_HTML_LENGTH - 7);
  expect(textToEmailHtml(max).length).toBe(MAX_EMAIL_HTML_LENGTH);
  expect(() => textToEmailHtml(max + "x")).toThrow("exceeds 250000");
  expect(() => textToEmailHtml("&".repeat(100_000))).toThrow("exceeds 250000");
});
