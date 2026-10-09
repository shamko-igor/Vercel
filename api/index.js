const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_HISTORY = 12;
const MAX_TEXT = 4000;

function sendJson(res, statusCode, payload) {
const body = JSON.stringify(payload);
if (typeof res.status === "function" && typeof res.json === "function") {
return res.status(statusCode).json(payload);
}
res.statusCode = statusCode;
if (typeof res.setHeader === "function") res.setHeader("Content-Type", "application/json; charset=utf-8");
if (typeof res.end === "function") return res.end(body);
throw new Error("Unsupported response object");
}

function reply(text, sessionState = {}) {
return {
version: "1.0",
response: { text: String(text || "Не получилось подготовить ответ. Попробуйте ещё раз.").slice(0, MAX_TEXT), end_session: false },
session_state: sessionState
};
}

function shouldSearch(text) {
return /\b(сейчас|сегодня|свеж(ие|ая|ую|их)|последн(ие|яя|юю)|актуальн(ый|ая|ое|ые)|новост(и|ях|ей)|курс валют|погода|цена|стоимость|кто сейчас|когда выйдет|результаты матч|на данный момент)\b/i.test(text);
}

async function searchWeb(query) {
if (!process.env.SERPER_API_KEY) return "";
const response = await fetch("https://google.serper.dev/search", {
method: "POST",
headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
body: JSON.stringify({ q: query, num: 5, gl: "ru", hl: "ru" }),
signal: AbortSignal.timeout(8000)
});
if (!response.ok) throw new Error("Serper request failed");
const data = await response.json();
return (data.organic || []).slice(0, 5).map((x, i) => `${i + 1}. ${x.title || ""}\n${x.snippet || ""}\n${x.link || ""}`).join("\n\n");
}

async function askGemini(command, history, searchContext) {
if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
const historyText = history.map(x => `${x.role === "model" ? "Алиса" : "Пользователь"}: ${x.text}`).join("\n");
const prompt = [
"Ты — голосовой ассистент в навыке Яндекс Алисы. Отвечай по-русски, естественно и кратко: обычно 1–3 предложения. Не используй Markdown, таблицы и длинные списки. Если не знаешь — честно скажи.",
searchContext ? "Используй результаты поиска для актуального ответа, не выдумывай факты.\nРЕЗУЛЬТАТЫ ПОИСКА:\n" + searchContext : "Если вопрос требует актуальных данных, а поиска нет, честно сообщи об ограничении.",
historyText ? "ПРЕДЫДУЩИЙ ДИАЛОГ:\n" + historyText : "",
"ТЕКУЩИЙ ЗАПРОС:\n" + command
].filter(Boolean).join("\n\n");
const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.6, maxOutputTokens: 220 } }),
signal: AbortSignal.timeout(20000)
});
if (!response.ok) {
console.error("Gemini API error", response.status, (await response.text()).slice(0, 500));
throw new Error("Gemini request failed");
}

const rawResponse = await response.text();

let data;
try {
  data = JSON.parse(rawResponse);
} catch (error) {
  console.error("Invalid JSON from Gemini:", response.status, rawResponse.slice(0, 1000));
  throw new Error("Gemini returned invalid JSON");
}


return (data.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("").trim() || "Не удалось сформировать ответ. Попробуйте переформулировать вопрос.";
}

module.exports = async function handler(req, res) {
if (req.method !== "POST") {
if (typeof res.setHeader === "function") res.setHeader("Allow", "POST");
return sendJson(res, 405, { error: "Method Not Allowed" });
}
try {
const body = req.body || {};
const command = [
body.request?.original_utterance,
body.request?.command
]
.map(value => String(value ?? "").trim())
.find(Boolean) || "";
const prior = body.state?.session || body.session_state || {};
const history = Array.isArray(prior.history) ? prior.history.filter(x => x && typeof x.text === "string" && ["user", "model"].includes(x.role)).slice(-MAX_HISTORY) : [];
if (!command) {
  return sendJson(res, 200, reply(
    "Диагностика: " + JSON.stringify({
      bodyType: typeof body,
      bodyKeys: Object.keys(body || {}),
      requestKeys: Object.keys(body.request || {}),
      original_utterance: body.request?.original_utterance,
      command: body.request?.command
    }),
    { history }
  ));
}
let searchContext = "";
if (shouldSearch(command) && process.env.SERPER_API_KEY) {
try { searchContext = await searchWeb(command); }
catch (error) { console.error("Search unavailable:", error.message); }
}
const answer = await askGemini(command, history, searchContext);
const nextHistory = [...history, { role: "user", text: command.slice(0, 1000) }, { role: "model", text: answer.slice(0, 1500) }].slice(-MAX_HISTORY);
return sendJson(res, 200, reply(answer, { history: nextHistory }));
} catch (error) {
console.error("Webhook error:", error.message);
return sendJson(res, 200, reply(
error.message === "GEMINI_API_KEY is not configured"
? "Сервис пока не настроен. Добавьте ключ Gemini в настройках проекта."
: "Извините, сейчас не удалось получить ответ. Попробуйте немного позже.",
{}
));
}
};
