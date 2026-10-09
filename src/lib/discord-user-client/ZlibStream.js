import zlib from "node:zlib";

const SYNC_FLUSH_SUFFIX = Buffer.from([0x00, 0x00, 0xff, 0xff]);

/**
 * Розпаковка транспорту `compress=zlib-stream`: один zlib-контекст на все
 * з'єднання, кожне повідомлення gateway закінчується Z_SYNC_FLUSH
 * (`00 00 ff ff`). Кадр без цього суфікса — частина повідомлення.
 * Новий контекст — на кожне нове з'єднання.
 *
 * push() повертає Promise: рядок JSON, коли повідомлення зібране, або null.
 * Порядок зберігається: розпаковка йде ланцюжком.
 */
export class ZlibStream {
  constructor() {
    this._inflate = zlib.createInflate();
    this._out = [];
    this._pending = [];
    this._chain = Promise.resolve();
    this._inflate.on("data", (chunk) => this._out.push(chunk));
    // Помилка розпаковки — у проміс поточного push, не необроблений "error".
    this._inflate.on("error", (error) => { this._error = error; });
  }

  /** @param {Buffer|ArrayBuffer|Buffer[]} data  Кадр з сокета. */
  push(data) {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    this._pending.push(buf);
    if (buf.length < 4 || !buf.subarray(-4).equals(SYNC_FLUSH_SUFFIX)) return Promise.resolve(null);
    const input = Buffer.concat(this._pending);
    this._pending = [];
    const run = () => new Promise((resolve, reject) => {
      this._inflate.write(input);
      this._inflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        if (this._error) return reject(this._error);
        const text = Buffer.concat(this._out).toString("utf8");
        this._out = [];
        resolve(text);
      });
    });
    const result = this._chain.then(run);
    this._chain = result.catch(() => {});
    return result;
  }

  close() {
    this._inflate.close();
  }
}
