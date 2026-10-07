/**
 * Ліміти платформ — факти їхніх API, не налаштування.
 *
 * Тут, а не в app.config.js: їх не налаштовують, вони не залежать від
 * розгортання, і зміна значення ламає відправку (платформа відхиляє запит).
 * Одне місце замість копій у кожному адаптері й рендері — щоб число, яке
 * колись зміниться в Discord чи Telegram, правилось раз.
 */

/** Discord API: повідомлення, embed, компоненти. */
export const DISCORD = Object.freeze({
  messageContent: 2000,     // content повідомлення
  embedTitle: 256,
  embedDescription: 4096,
  embedAuthor: 256,
  embedFooter: 2048,
  embedFieldValue: 1024,
  embedTotal: 6000,         // сума всіх текстів одного повідомлення (усіх embed)
  embedsPerMessage: 10,
  buttonsPerRow: 5,
  componentRows: 5,         // 5 рядів × 5 кнопок = 25
  channelTopic: 1024,
  slowmodeSeconds: 21_600,
});

/** Telegram MTProto, user-акаунт (не Bot API). */
export const TELEGRAM = Object.freeze({
  message: 4096,
  caption: 1024,            // підпис до медіа без Premium
  captionPremium: 4096,     // з Premium (caption_length_limit_premium)
  fileBytes: 2000 * 1024 * 1024,
});
