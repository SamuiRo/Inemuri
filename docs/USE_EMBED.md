# Робота з медіа в Inemuri

## Відповіді на твої питання

### 1. Як додати новий тип медіа?

Для додавання нового типу медіа потрібно зробити зміни в двох місцях:

#### В TelegramSourceListener.js:

```javascript
// Додати тип в downloadableMediaTypes
this.downloadableMediaTypes = ["photo", "video", "document", "animation", "sticker"];

// Оновити parseMedia() для розпізнавання типу
parseMedia(message) {
  // ... існуючий код ...
  
  // Додати логіку для нового типу
  if (doc.attributes) {
    for (const attr of doc.attributes) {
      // ... існуючі перевірки ...
      else if (attr.className === "DocumentAttributeSticker") {
        mediaInfo.type = "sticker";
        mediaInfo.emoji = attr.alt;
      }
    }
  }
}
```

#### В DiscordDestination.js:

```javascript
// Додати конфігурацію типу медіа
this.supportedMediaTypes = {
  // ... існуючі типи ...
  sticker: {
    extensions: ["webp", "png"],
    defaultExtension: "webp",
    canEmbed: true,  // чи можна відображати в embed
  },
};

// Оновити MIME map якщо потрібно
getExtensionFromMimeType(mimeType, allowedExtensions) {
  const mimeMap = {
    // ... існуючі ...
    "image/webp": "webp",
  };
}
```

### 2. Як використовувати embed?

Є два способи активувати embed для зображень:

#### Спосіб 1: Передати `useEmbed: true`
```javascript
const messageData = {
  text: "Дивись яка гарна картинка!",
  downloadedMedia: [{ type: "photo", data: buffer, mimeType: "image/png" }],
  useEmbed: true,  // ✅ Автоматично створить embed
};
```

#### Спосіб 2: Передати готовий об'єкт `embed`
```javascript
const messageData = {
  text: "Текст повідомлення",
  downloadedMedia: [{ type: "photo", data: buffer }],
  embed: {
    title: "Заголовок",
    description: "Опис",
    color: 0x00ff00,
    footer: "Футер",
    // image автоматично встановиться з downloadedMedia
  },
};
```

**Важливо:** Тільки типи медіа з `canEmbed: true` можуть бути в embed (photo, animation).

### 3. Обробка великих файлів (відео)

Система автоматично перевіряє розмір файлів:

```javascript
// В DiscordDestination.js автоматично:
// 1. Перевіряється розмір кожного файлу
// 2. Файли > 25MB (або 100MB для Nitro) пропускаються
// 3. Додається попередження в текст повідомлення
// 4. Якщо всі файли надто великі - надсилається тільки текст
```

#### Налаштування ліміту для сервера з Nitro:
```javascript
// В inemuri.js після створення адаптера:
this.discordDestination.setFileSizeLimit(true); // 100MB для Nitro
```

#### Що відбувається з великими файлами:

1. **Файл < 25MB** → надсилається нормально ✅
2. **Файл 25-100MB** → пропускається, додається попередження ⚠️
3. **Всі файли великі** → надсилається тільки текст або "не вдалося надіслати" ❌

**Приклад виводу:**
```
Текст повідомлення
⚠️ 2 файл(ів) пропущено через обмеження розміру (>25MB)
```

### 4. Чому PNG а не JPG для фото?

**PNG обрано за замовчуванням з таких причин:**

1. **Якість**: PNG без втрат (lossless), JPG з втратами (lossy)
2. **Прозорість**: PNG підтримує альфа-канал
3. **Гнучкість**: Discord однаково добре обробляє обидва формати

**Але!** Формат визначається автоматично на основі MIME type:

```javascript
// Якщо Telegram надає MIME type, використовується він:
downloadedMedia: [
  {
    type: "photo",
    mimeType: "image/jpeg",  // → буде збережено як .jpg
    data: buffer
  }
]

// Якщо MIME type немає, використовується defaultExtension (png)
```

#### Як змінити поведінку:

```javascript
// В DiscordDestination.js
this.supportedMediaTypes = {
  photo: {
    extensions: ["jpg", "jpeg", "png", "gif", "webp"],
    defaultExtension: "jpg", // ← Змінити тут якщо потрібно JPG за замовчуванням
    canEmbed: true,
  },
};
```

## Повна структура messageData

```javascript
{
  // Основні дані
  platform: "telegram",
  channelId: "123456789",
  messageId: 42,
  text: "Текст повідомлення",
  timestamp: Date,
  
  // Медіа (RAW з Telegram - не використовується в Discord)
  media: {
    type: "photo",
    raw: TelegramMediaObject,
    filename: "image.png",
    mimeType: "image/png",
    fileSize: 1024000,
  },
  
  // Завантажені медіа (використовується в Discord)
  downloadedMedia: [
    {
      type: "photo",
      data: Buffer,
      filename: "image.png",
      mimeType: "image/png",
      fileSize: 1024000,
      // Для відео додатково:
      duration: 60,
      width: 1920,
      height: 1080,
    }
  ],
  
  // Опції для Discord
  useEmbed: true, // або false
  
  // Або готовий embed
  embed: {
    title: "Заголовок",
    description: "Опис",
    color: 0x5865f2,
    footer: "Футер",
    timestamp: Date,
    url: "https://...",
    fields: [
      { name: "Поле 1", value: "Значення", inline: true }
    ]
    // image встановлюється автоматично з downloadedMedia
  },
  
  // Метадані джерела
  source: {
    id: 1,
    name: "Channel Name",
    destinations: [...]
  }
}
```

## Приклади використання

### Приклад 1: Просте фото з текстом
```javascript
const messageData = {
  text: "Подивіться на цей захід сонця!",
  downloadedMedia: [
    {
      type: "photo",
      data: photoBuffer,
      mimeType: "image/png"
    }
  ]
};
// Результат: фото + текст під ним
```

### Приклад 2: Фото в embed
```javascript
const messageData = {
  downloadedMedia: [
    {
      type: "photo",
      data: photoBuffer
    }
  ],
  embed: {
    title: "Захід сонця",
    description: "Вечір на березі моря",
    color: 0xff6b35,
    footer: "Фото дня"
  }
};
// Результат: красивий embed з фото
```

### Приклад 3: Відео (можливо велике)
```javascript
const messageData = {
  text: "Цікаве відео!",
  downloadedMedia: [
    {
      type: "video",
      data: videoBuffer,
      mimeType: "video/mp4",
      fileSize: 30 * 1024 * 1024, // 30MB
      duration: 120
    }
  ]
};
// Результат: 
// - Якщо ліміт 25MB → "Цікаве відео!\n⚠️ 1 файл пропущено..."
// - Якщо ліміт 100MB (Nitro) → відео + текст
```

### Приклад 4: Альбом фото
```javascript
const messageData = {
  text: "Фото з відпустки",
  downloadedMedia: [
    { type: "photo", data: photo1Buffer },
    { type: "photo", data: photo2Buffer },
    { type: "photo", data: photo3Buffer }
  ],
  useEmbed: true
};
// Результат: 3 фото + embed з першим фото
```

## Додаткові можливості

### Компресія відео (TODO)
Наразі компресія не реалізована. Для додавання:

1. Встановити `fluent-ffmpeg`
2. Додати метод `compressVideo()` в `DiscordDestination.js`
3. Викликати перед перевіркою розміру

### Підтримка інших платформ
Структура дозволяє легко додати інші destination адаптери (Telegram, Slack, тощо):

```javascript
class TelegramDestinationAdapter extends BaseDestinationAdapter {
  async formatMessage(messageData) {
    // Конвертувати downloadedMedia в Telegram InputMedia
  }
}
```