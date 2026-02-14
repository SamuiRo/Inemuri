# Text Replacements - Документація

## Огляд

Text Replacements - це механізм препроцесингу тексту повідомлень **перед** застосуванням фільтрів. Використовується для видалення футерів, шапок, повторюваних елементів та іншого "шуму", який може містити ключові слова та помилково тригерити whitelist або blacklist.

## Архітектура

```
Вхідне повідомлення
       ↓
  Препроцесинг (text_replacements)
       ↓
  Фільтрація (keywords/blacklist)
       ↓
  Доставка до destinations
```

### Важливі особливості:

1. **Послідовність виконання**: Replacements → Filters
2. **Кешування**: Всі regex patterns компілюються один раз при старті
3. **Продуктивність**: O(1) lookup з кешу + O(n) для кожного pattern

## Конфігурація

### Структура в `Source` моделі:

```javascript
{
  "text_replacements": {
    "enabled": true,
    "patterns": [
      {
        "pattern": "текст або regex",
        "replacement": "текст заміни (або пусто для видалення)",
        "is_regex": true/false,
        "flags": "gi" // опціонально, для regex
      }
    ]
  }
}
```

### Параметри:

| Параметр | Тип | Опис |
|----------|-----|------|
| `enabled` | boolean | Увімкнути/вимкнути препроцесинг |
| `patterns` | array | Масив правил заміни |
| `pattern` | string | Текст або regex для пошуку |
| `replacement` | string | Текст заміни (пусто = видалення) |
| `is_regex` | boolean | Чи є pattern регулярним виразом |
| `flags` | string | Прапорці для regex (g, i, s, m) |

## Приклади використання

### 1. Видалення простого футера

```json
{
  "pattern": "━━━━━━━━━━━━━━━",
  "replacement": "",
  "is_regex": false
}
```

**До:**
```
Нова гра у Steam!
━━━━━━━━━━━━━━━
📢 Канал: @gamechannel
```

**Після:**
```
Нова гра у Steam!


📢 Канал: @gamechannel
```

---

### 2. Видалення рядка з посиланням на канал

```json
{
  "pattern": "📢 Канал:.*?\\n",
  "replacement": "",
  "is_regex": true,
  "flags": "gi"
}
```

**До:**
```
Нова гра у Steam!
📢 Канал: @gamechannel
Знижка 50%!
```

**Після:**
```
Нова гра у Steam!
Знижка 50%!
```

---

### 3. Видалення блоку між маркерами

```json
{
  "pattern": "🎮 FOOTER:.*?END FOOTER",
  "replacement": "",
  "is_regex": true,
  "flags": "gis"
}
```

**Примітка**: Прапорець `s` дозволяє `.` співпадати з `\n`

**До:**
```
Нова гра у Steam!
🎮 FOOTER:
Реклама
Підписуйтесь
END FOOTER
Знижка!
```

**Після:**
```
Нова гра у Steam!

Знижка!
```

---

### 4. Заміна тексту (не видалення)

```json
{
  "pattern": "@gamechannel",
  "replacement": "[CHANNEL]",
  "is_regex": false
}
```

**До:**
```
Нова гра від @gamechannel
```

**Після:**
```
Нова гра від [CHANNEL]
```

---

### 5. Видалення всіх згадок (@mentions)

```json
{
  "pattern": "@\\w+",
  "replacement": "",
  "is_regex": true,
  "flags": "g"
}
```

**До:**
```
Check @channel1 and @channel2 for updates
```

**Після:**
```
Check  and  for updates
```

---

### 6. Видалення URL

```json
{
  "pattern": "https?://\\S+",
  "replacement": "",
  "is_regex": true,
  "flags": "gi"
}
```

**До:**
```
Дивись тут: https://example.com/game
Ще тут: http://steam.com
```

**Після:**
```
Дивись тут: 
Ще тут: 
```

## Повний приклад конфігурації

```json
{
  "platform": "telegram",
  "channel_id": "-1001317658512",
  "channel_name": "Gaming News",
  "is_active": true,
  "text_replacements": {
    "enabled": true,
    "patterns": [
      {
        "pattern": "━━━━━━━━━━━━━━━",
        "replacement": "",
        "is_regex": false,
        "comment": "Видалення декоративних ліній"
      },
      {
        "pattern": "📢 Канал:.*?\\n",
        "replacement": "",
        "is_regex": true,
        "flags": "gi",
        "comment": "Видалення посилань на канал"
      },
      {
        "pattern": "\\[AD\\].*?\\[/AD\\]",
        "replacement": "",
        "is_regex": true,
        "flags": "gis",
        "comment": "Видалення рекламних блоків"
      },
      {
        "pattern": "@\\w+",
        "replacement": "",
        "is_regex": true,
        "flags": "g",
        "comment": "Видалення всіх @mentions"
      }
    ]
  },
  "filters": {
    "enabled": true,
    "keywords": ["game", "free", "discount"],
    "blacklist": ["spam", "ad"],
    "case_sensitive": false
  },
  "destinations": {
    "telegram": ["-123456"],
    "discord": ["987654321"]
  }
}
```

## Regex Patterns - Корисні шаблони

### Багаторядковий текст

```javascript
{
  "pattern": "START.*?END",
  "flags": "gis"  // 's' дозволяє '.' співпадати з '\n'
}
```

### Емодзі

```javascript
{
  "pattern": "[\\u{1F300}-\\u{1F9FF}]",
  "flags": "gu"  // 'u' для Unicode
}
```

### Телефони

```javascript
{
  "pattern": "\\+?\\d{1,3}[\\s-]?\\(?\\d{1,4}\\)?[\\s-]?\\d{1,4}[\\s-]?\\d{1,9}",
  "flags": "g"
}
```

### Email

```javascript
{
  "pattern": "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b",
  "flags": "g"
}
```

## Best Practices

### ✅ Правильно:

```json
{
  "patterns": [
    {
      "pattern": "FOOTER:.*?END",
      "replacement": "",
      "is_regex": true,
      "flags": "gis",
      "comment": "Пояснення навіщо це правило"
    }
  ]
}
```

### ❌ Неправильно:

```json
{
  "patterns": [
    {
      "pattern": ".*",  // ❌ Видалить весь текст!
      "replacement": ""
    }
  ]
}
```

### Порядок patterns має значення

Patterns застосовуються послідовно, тому:

```json
{
  "patterns": [
    // 1. Спочатку видаляємо великі блоки
    {
      "pattern": "\\[AD\\].*?\\[/AD\\]",
      "replacement": "",
      "is_regex": true,
      "flags": "gis"
    },
    // 2. Потім видаляємо дрібні елементи
    {
      "pattern": "@\\w+",
      "replacement": "",
      "is_regex": true,
      "flags": "g"
    }
  ]
}
```

## Продуктивність

### Оптимізації в MessageFilter:

1. **Компіляція при старті**: Всі regex компілюються один раз
2. **Кешування**: Результати зберігаються в Map
3. **Мінімум викликів**: Один lookup на повідомлення

### Рекомендації:

- Використовуйте `is_regex: false` для простих рядків (швидше)
- Уникайте складних regex з backtracking
- Обмежте кількість patterns до 5-10 на source

## Тестування

### Приклад тестування replacements:

```javascript
import messageFilter from './module/filters/MessageFilter.js';

const source = {
  id: 1,
  text_replacements: {
    enabled: true,
    patterns: [
      {
        pattern: "━━━━━━",
        replacement: "",
        is_regex: false
      }
    ]
  }
};

const compiled = messageFilter.compileReplacements(source.id, source.text_replacements);
const result = messageFilter.preprocessText(compiled, "Test ━━━━━━ Footer");
console.log(result); // "Test  Footer"
```

### Детальна перевірка:

```javascript
const detailed = messageFilter.checkMessageDetailed(source, "Test ━━━━━━ game");
console.log(detailed);
// {
//   passed: true/false,
//   reason: "...",
//   originalText: "Test ━━━━━━ game",
//   processedText: "Test  game"
// }
```

## Міграція бази даних

Після додавання нового поля `text_replacements`, база даних автоматично оновиться через `database.sync()`.

Для існуючих джерел значення за замовчуванням:

```javascript
{
  enabled: false,
  patterns: []
}
```

## Troubleshooting

### Проблема: Фільтри не працюють після додавання replacements

**Рішення**: Очистіть кеш:

```javascript
messageFilter.clearCache();
await telegramListener.reloadWhitelist();
```

### Проблема: Regex pattern не компілюється

**Рішення**: Перевірте валідність regex:

```javascript
try {
  new RegExp(pattern, flags);
} catch (error) {
  console.error('Invalid regex:', pattern);
}
```

### Проблема: Весь текст видаляється

**Рішення**: Перевірте pattern - можливо він занадто широкий:

```javascript
// ❌ Погано
"pattern": ".*"

// ✅ Добре
"pattern": "FOOTER:.*?END FOOTER"
```

## API

### MessageFilter методи:

```javascript
// Компіляція replacements
compileReplacements(sourceId, textReplacements)

// Препроцесинг тексту
preprocessText(compiledReplacements, messageText)

// Швидка перевірка з препроцесингом
checkMessageFast(compiledReplacements, compiledFilter, messageText)

// Детальна перевірка з інформацією
checkMessageDetailed(source, messageText)

// Очистка кешу
clearCache(sourceId = null)

// Статистика
getCacheStats()
```

### Source методи:

```javascript
// Препроцесинг тексту
source.preprocessText(messageText)

// Перевірка фільтрів (з автоматичним препроцесингом)
source.passesFilter(messageText)
```

## Changelog

### v1.0.0
- ✅ Додано `text_replacements` поле в Source модель
- ✅ Додано підтримку regex та simple string patterns
- ✅ Додано кешування скомпільованих patterns
- ✅ Інтеграція в TelegramSourceListener
- ✅ Препроцесинг перед фільтрацією