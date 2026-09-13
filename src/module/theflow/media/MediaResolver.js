import { print } from "../../../shared/utils.js";

/**
 * TheFlow — media resolver seam (ROADMAP §2.5).
 *
 * Stage 3 (delivery) downloads media *lazily* — only for posts that survive
 * deduplication and are actually sent. `posts.media_ref` says how to fetch it,
 * per platform:
 *
 *   { kind: "telegram", channel_id, message_id, grouped_id }
 *   { kind: "url", urls: ["https://…/image.jpg"] }
 *
 * This registry maps `media_ref.kind` to a resolver. `resolve(post)` returns a
 * uniform list the delivery path can hand to a destination adapter:
 *
 *   [{ type, buffer, filename, mimeType, fileSize, duration, width, height }]
 *
 * (`buffer` is the bytes; a future resolver that streams to disk would return
 * `path` instead.)
 *
 * Registration happens in ./index.js. `TelegramMediaResolver` ships now;
 * `UrlMediaResolver` arrives with the Reddit/RSS adapters in phase 3.5, and is
 * an added `register("url", …)` line — not a change to the delivery path.
 */
export class MediaResolver {
  #resolvers = new Map(); // kind -> { resolve(post): Promise<object[]> }

  /**
   * @param {string} kind  Value of `media_ref.kind` this resolver handles.
   * @param {{ resolve(post): Promise<object[]> }} resolver
   */
  register(kind, resolver) {
    if (typeof resolver?.resolve !== "function") {
      throw new Error(`MediaResolver.register("${kind}"): resolver needs a resolve() method`);
    }
    this.#resolvers.set(kind, resolver);
    print(`[MEDIA] resolver registered for kind "${kind}"`, "debug");
  }

  /**
   * @param {import("../../teapot/models/Post.js").default} post
   * @param {{types?: string[], limit?: number}} [opts]
   *   `types` — качати лише ці типи медіа; `limit` — не більше стількох файлів.
   *   Обидва застосовуються ДО завантаження: vision потрібні лише зображення,
   *   і без цього пост із відео тягнув би весь ролик, щоб його викинути.
   * @returns {Promise<object[]>} Downloaded file records; `[]` when the post
   *   has no media or `media_ref` was never written.
   */
  async resolve(post, opts = {}) {
    const ref = post?.media_ref;
    if (!ref || !ref.kind) return [];

    const resolver = this.#resolvers.get(ref.kind);
    if (!resolver) {
      throw new Error(`No media resolver registered for kind "${ref.kind}"`);
    }
    const files = await resolver.resolve(post, opts);
    return Array.isArray(files) ? files : [];
  }

  get kinds() {
    return [...this.#resolvers.keys()];
  }
}

// Singleton — one shared registry, like EventBus / MessageRouter.
const mediaResolver = new MediaResolver();
export default mediaResolver;
