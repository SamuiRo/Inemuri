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
