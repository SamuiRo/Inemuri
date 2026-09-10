import axios from "axios";

import { BaseProvider, ProviderError } from "./BaseProvider.js";

/**
 * Any OpenAI-compatible chat-completions endpoint — OpenRouter, Qwen, and
 * most other compatible APIs — parameterized by base URL.
 *
 *   complete -> POST {baseUrl}/chat/completions
 *   embed    -> POST {baseUrl}/embeddings   (only if embedModel is configured;
 *               OpenRouter is chat-only and may not expose this — ROADMAP §3.1)
 *
 * Auth: `Authorization: Bearer {key}`. Structured output:
 * `response_format: { type: "json_schema", json_schema: { name, schema, strict } }`,
 * with a plain `{ type: "json_object" }` fallback left to the gateway if a
 * model id rejects json_schema.
 */
export class OpenAICompatProvider extends BaseProvider {
  constructor(name, config, http) {
    super(name ?? "openrouter", config, http ?? axios);
  }

  _client(timeoutMs) {
    return {
      baseURL: this.config.baseUrl,
      timeout: timeoutMs ?? 30_000,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
    };
  }

  async complete(messages, options = {}) {
    const model = this.config.completeModel;
    const msgs = [];
    if (messages.system) msgs.push({ role: "system", content: messages.system });
    msgs.push({ role: "user", content: messages.user ?? "" });

    const body = {
      model,
      messages: msgs,
      temperature: options.temperature ?? 0,
      response_format: options.schema
        ? { type: "json_schema", json_schema: { name: "enrich", schema: options.schema, strict: true } }
        : { type: "json_object" },
    };

    let res;
    try {
      res = await this.http.post("/chat/completions", body, this._client(options.timeoutMs));
    } catch (error) {
      throw this.classifyHttpError(error, "complete");
    }

    const text = res.data?.choices?.[0]?.message?.content ?? "";
    if (!text) {
      throw new ProviderError(`${this.name} complete: empty message content`, {
        kind: "bad_response", status: res.status ?? null,
      });
    }
    return { text, model, raw: res.data };
  }

  async embed(text) {
    if (!this.config.embedModel) {
      throw new ProviderError(`${this.name} embed: no embedModel configured`, { kind: "bad_response" });
    }
    let res;
    try {
      res = await this.http.post(
        "/embeddings",
        { model: this.config.embedModel, input: String(text ?? "") },
        this._client(),
      );
    } catch (error) {
      throw this.classifyHttpError(error, "embed");
    }

    const values = res.data?.data?.[0]?.embedding;
    if (!Array.isArray(values) || values.length === 0) {
      throw new ProviderError(`${this.name} embed: no embedding in response`, {
        kind: "bad_response", status: res.status ?? null,
      });
    }
    const vector = BaseProvider.toUnitVector(values);
    return { vector, model: this.config.embedModel, dim: vector.length };
  }
}

export default OpenAICompatProvider;
