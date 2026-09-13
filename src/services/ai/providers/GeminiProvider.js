import axios from "axios";

import { BaseProvider, ProviderError } from "./BaseProvider.js";

/**
 * Google Gemini via the Generative Language API (v1beta).
 *
 *   complete -> POST /models/{model}:generateContent
 *   embed    -> POST /models/{embedModel}:embedContent
 *
 * Auth: `x-goog-api-key` header. Structured output: `generationConfig`
 * `responseMimeType: "application/json"` + `responseSchema`.
 */
export class GeminiProvider extends BaseProvider {
  constructor(config, http) {
    super("gemini", config, http ?? axios);
  }

  _client(timeoutMs) {
    return {
      baseURL: this.config.baseUrl,
      timeout: timeoutMs ?? 30_000,
      headers: { "x-goog-api-key": this.config.apiKey, "content-type": "application/json" },
    };
  }

  /**
   * @param {{system?: string, user: string}} messages
   * @param {{schema?: object, temperature?: number, timeoutMs?: number}} options
   */
  async complete(messages, options = {}) {
    const model = this.config.completeModel;
    const body = {
      contents: [{ role: "user", parts: [{ text: messages.user ?? "" }] }],
      generationConfig: {
        temperature: options.temperature ?? 0,
        responseMimeType: "application/json",
        ...(options.schema ? { responseSchema: options.schema } : {}),
      },
    };
    if (messages.system) {
      body.systemInstruction = { parts: [{ text: messages.system }] };
    }

    let res;
    try {
      res = await this.http.post(
        `/models/${encodeURIComponent(model)}:generateContent`,
        body,
        this._client(options.timeoutMs),
      );
    } catch (error) {
      throw this.classifyHttpError(error, "complete");
    }

    const cand = res.data?.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ?? "";
    if (!text) {
      throw new ProviderError("gemini complete: empty candidate text", {
        kind: "bad_response", status: res.status ?? null,
      });
    }
    return { text, model, raw: res.data };
  }

  /**
   * Транскрипція зображення (VISION.md). Повертає сирий текст відповіді, як і
   * complete(): розбір і валідацію робить gateway, щоб логіка перевірки жила
   * в одному місці для обох викликів.
   *
   * @param {{data: Buffer, mimeType: string}} image  Уже зменшене зображення.
   * @param {{system: string, user: string, schema?: object, temperature?: number, timeoutMs?: number}} options
   */
  async vision(image, options = {}) {
    const model = this.config.visionModel;
    if (!model) {
      throw new ProviderError("gemini vision: no visionModel configured", { kind: "bad_response" });
    }
    if (!image?.data || !image?.mimeType) {
      throw new ProviderError("gemini vision: image data and mimeType are required", { kind: "bad_response" });
    }

    const body = {
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: image.mimeType, data: Buffer.from(image.data).toString("base64") } },
          { text: options.user ?? "" },
        ],
      }],
      generationConfig: {
        temperature: options.temperature ?? 0,
        responseMimeType: "application/json",
        ...(options.schema ? { responseSchema: options.schema } : {}),
      },
    };
    if (options.system) body.systemInstruction = { parts: [{ text: options.system }] };

    let res;
    try {
      res = await this.http.post(
        `/models/${encodeURIComponent(model)}:generateContent`,
        body,
        this._client(options.timeoutMs),
      );
    } catch (error) {
      throw this.classifyHttpError(error, "vision");
    }

    // Фільтр безпеки Google. Блок детермінований для цього знімка: повтор
    // лише спалив би квоту, а fallback надіслав би те саме зображення. Тож
    // це не помилка з ретраєм, а «тексту не отримати» — і видно чому.
    const blockReason = res.data?.promptFeedback?.blockReason;
    const cand = res.data?.candidates?.[0];
    if (blockReason || cand?.finishReason === "SAFETY") {
      return {
        text: JSON.stringify({
          text_ocr: "",
          description: `blocked by provider safety filter (${blockReason ?? cand.finishReason})`,
          legible: false,
        }),
        model,
        blocked: true,
      };
    }

    const text = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ?? "";
    if (!text) {
      throw new ProviderError("gemini vision: empty candidate text", {
        kind: "bad_response", status: res.status ?? null,
      });
    }
    return { text, model };
  }

  async embed(text) {
    if (!this.config.embedModel) {
      throw new ProviderError("gemini embed: no embedModel configured", { kind: "bad_response" });
    }
    const model = this.config.embedModel;
    let res;
    try {
      res = await this.http.post(
        `/models/${encodeURIComponent(model)}:embedContent`,
        {
          content: { parts: [{ text: String(text ?? "") }] },
          ...(this.config.embedDim ? { outputDimensionality: this.config.embedDim } : {}),
        },
        this._client(),
      );
    } catch (error) {
      throw this.classifyHttpError(error, "embed");
    }

    const values = res.data?.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new ProviderError("gemini embed: no embedding in response", {
        kind: "bad_response", status: res.status ?? null,
      });
    }
    const vector = BaseProvider.toUnitVector(values);
    return { vector, model, dim: vector.length };
  }
}

export default GeminiProvider;
