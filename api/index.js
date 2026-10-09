const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_HISTORY = 12;
const MAX_TEXT = 4000;

// Отправка JSON-ответа
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);

  if (
    typeof res.status === "function" &&
    typeof res.json === "function"
  ) {
    return res.status(statusCode).json(payload);
  }

  res.statusCode = statusCode;

  if (typeof res.setHeader === "function") {
    res.setHeader(
      "Content-Type",
      "application/json; charset=utf-8"
    );
  }

  return res.end(body);
}

// Формирование ответа для Яндекс Алисы
function reply(text, sessionState = {}) {
  return {
    version: "1.0",
    response: {
      text: String(
        text || "Не получилось подготовить ответ. Попробуйте ещё раз."
      ).slice(0, MAX_TEXT),
      end_session: false
    },
    session_state: sessionState
  };
}

// Определяем, нужен ли актуальный поиск
function shouldSearch(text) {
  return /\b(сейчас|сегодня|свеж(ие|ая|ую|их)|последн(ие|яя|юю)|актуальн(ый|ая|ое|ые)|новост(и|ях|ей)|курс валют|погода|цена|стоимость|кто сейчас|когда выйдет|результаты матч|на данный момент)\b/i.test(
    text
  );
}

// Поиск через Serper
async function searchWeb(query) {
  if (!process.env.SERPER_API_KEY) {
    console.warn("SERPER_API_KEY is not configured");
    return "";
  }

  const response = await fetch(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: query,
        num: 5,
        gl: "ru",
        hl: "ru"
      }),
      signal: AbortSignal.timeout(8000)
    }
  );

  const rawResponse = await response.text();

  let data;

  try {
    data = JSON.parse(rawResponse);
  } catch (error) {
    console.error(
      "Serper returned invalid JSON:",
      response.status,
      rawResponse.slice(0, 1000)
    );
    throw new Error("Serper returned invalid JSON");
  }

  if (!response.ok) {
    console.error(
      "Serper API error:",
      response.status,
      JSON.stringify(data).slice(0, 1000)
    );
    throw new Error("Serper request failed");
  }

  return (data.organic || [])
    .slice(0, 5)
    .map((item, index) => {
      return [
        `${index + 1}. ${item.title || ""}`,
        item.snippet || "",
        item.link || ""
      ].join("\n");
    })
    .join("\n\n");
}

// Запрос к Gemini с диагностикой ошибок
async function askGemini(command, history, searchContext) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const historyText = history
    .map(item => {
      const role = item.role === "model" ? "Алиса" : "Пользователь";
      return `${role}: ${item.text}`;
    })
    .join("\n");

  const prompt = [
    "Ты — голосовой ассистент в навыке Яндекс Алисы.",
    "Отвечай по-русски, естественно и кратко: обычно 1–3 предложения.",
    "Не используй Markdown, таблицы и длинные списки.",
    "Если не знаешь ответ, честно скажи.",
    searchContext
      ? "Используй результаты поиска для актуального ответа. Не выдумывай факты.\nРЕЗУЛЬТАТЫ ПОИСКА:\n" + searchContext
      : "Если вопрос требует актуальных данных, а поиска нет, честно сообщи об ограничении.",
    historyText
      ? "ПРЕДЫДУЩИЙ ДИАЛОГ:\n" + historyText
      : "",
    "ТЕКУЩИЙ ЗАПРОС:\n" + command
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 220
        }
      }),
      signal: AbortSignal.timeout(20000)
    }
  );

  // Сначала читаем тело как текст, чтобы диагностировать Invalid JSON
  const rawResponse = await response.text();

  let data;

  try {
    data = JSON.parse(rawResponse);
  } catch (error) {
    console.error(
      "Invalid JSON from Gemini:",
      response.status,
      rawResponse.slice(0, 1000)
    );

    throw new Error("Gemini returned invalid JSON");
  }

  if (!response.ok) {
    // Ошибка API обычно содержит полезное сообщение в JSON
    console.error(
      "Gemini API error:",
      response.status,
      JSON.stringify(data).slice(0, 1000)
    );

    throw new Error("Gemini request failed");
  }

  const answer = (data.candidates?.[0]?.content?.parts || [])
    .map(part => part.text || "")
    .join("")
    .trim();

  if (!answer) {
    console.error(
      "Gemini returned no answer:",
      JSON.stringify(data).slice(0, 1000)
    );

    return "Не удалось сформировать ответ. Попробуйте переформулировать вопрос.";
  }

  return answer;
}

// Основной обработчик webhook
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    if (typeof res.setHeader === "function") {
      res.setHeader("Allow", "POST");
    }

    return sendJson(res, 405, {
      error: "Method Not Allowed"
    });
  }

  try {
   let body;

try {
  if (typeof req.body === "string") {
    body = JSON.parse(req.body);
  } else {
    body = req.body;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }
} catch (error) {
  console.error("Invalid incoming request body:", error.message);

  return sendJson(res, 400, {
    error: "Invalid JSON in request body"
  });
}

    const command = [
      body.request?.original_utterance,
      body.request?.command
    ]
      .map(value => String(value ?? "").trim())
      .find(Boolean) || "";

    const prior = body.state?.session || body.session_state || {};

    const history = Array.isArray(prior.history)
      ? prior.history
          .filter(
            item =>
              item &&
              typeof item.text === "string" &&
              ["user", "model"].includes(item.role)
          )
          .slice(-MAX_HISTORY)
      : [];

    // Диагностика запроса от Алисы, если текст не найден
    if (!command) {
      console.warn(
        "No command received. Request keys:",
        JSON.stringify({
          bodyKeys: Object.keys(body),
          requestKeys: Object.keys(body.request || {}),
          hasSession: Boolean(body.session)
        })
      );

      return sendJson(
        res,
        200,
        reply(
          "Не расслышал вопрос. Повторите, пожалуйста.",
          { history }
        )
      );
    }

    let searchContext = "";

    if (shouldSearch(command) && process.env.SERPER_API_KEY) {
      try {
        searchContext = await searchWeb(command);
      } catch (error) {
        console.error("Search unavailable:", error.message);
      }
    }

    const answer = await askGemini(
      command,
      history,
      searchContext
    );

    const nextHistory = [
      ...history,
      {
        role: "user",
        text: command.slice(0, 1000)
      },
      {
        role: "model",
        text: answer.slice(0, 1500)
      }
    ].slice(-MAX_HISTORY);

    return sendJson(
      res,
      200,
      reply(answer, { history: nextHistory })
    );
  } catch (error) {
    console.error(
      "Webhook error:",
      error?.stack || error?.message || String(error)
    );

    let message =
      "Извините, сейчас не удалось получить ответ. Попробуйте немного позже.";

    if (error.message === "GEMINI_API_KEY is not configured") {
      message =
        "Сервис пока не настроен. Проверьте ключ Gemini в настройках проекта.";
    }

    return sendJson(
      res,
      200,
      reply(message, {})
    );
  }
};
