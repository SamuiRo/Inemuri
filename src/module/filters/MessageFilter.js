import { print } from "../../shared/utils.js";

/**
 * Ефективний фільтр повідомлень з кешуванням
 * Використовує Set для O(1) lookup замість Array.includes()
 */
class MessageFilter {
  constructor() {
    // Кеш для компільованих фільтрів
    this.compiledFilters = new Map();
    // Кеш для компільованих replacements
    this.compiledReplacements = new Map();
  }

  /**
   * Компіляція text replacements в оптимізований формат
   */
  compileReplacements(sourceId, textReplacements) {
    if (!textReplacements || !textReplacements.enabled || !textReplacements.patterns) {
      return null;
    }

    const compiled = {
      enabled: true,
      patterns: textReplacements.patterns
        .filter(item => item.pattern) // Тільки валідні патерни
        .map(item => {
          try {
            // Якщо це regex
            if (item.is_regex || item.flags) {
              return {
                type: 'regex',
                regex: new RegExp(item.pattern, item.flags || 'gi'),
                replacement: item.replacement || ''
              };
            } else {
              // Проста заміна рядка
              return {
                type: 'string',
                pattern: item.pattern,
                replacement: item.replacement || ''
              };
            }
          } catch (error) {
            console.error(`[MessageFilter] Invalid regex pattern for source ${sourceId}:`, item.pattern);
            return null;
          }
        })
        .filter(Boolean) // Видаляємо null від invalid patterns
    };

    // Кешуємо
    this.compiledReplacements.set(sourceId, compiled);
    
    return compiled;
  }

  /**
   * Компіляція фільтру в оптимізований формат
   */
  compileFilter(sourceId, filters) {
    if (!filters || !filters.enabled) {
      return null;
    }

    const caseSensitive = filters.case_sensitive || false;

    // Конвертуємо масиви в Set для швидкого пошуку O(1)
    const compiled = {
      enabled: true,
      caseSensitive: caseSensitive,
      keywords: filters.keywords && filters.keywords.length > 0
        ? new Set(caseSensitive 
            ? filters.keywords 
            : filters.keywords.map(k => k.toLowerCase()))
        : null,
      blacklist: filters.blacklist && filters.blacklist.length > 0
        ? new Set(caseSensitive 
            ? filters.blacklist 
            : filters.blacklist.map(b => b.toLowerCase()))
        : null
    };

    // Кешуємо
    this.compiledFilters.set(sourceId, compiled);
    
    return compiled;
  }

  /**
   * Отримати скомпільовані replacements з кешу або створити нові
   */
  getCompiledReplacements(source) {
    const cached = this.compiledReplacements.get(source.id);
    
    if (cached !== undefined) {
      return cached;
    }

    return this.compileReplacements(source.id, source.text_replacements);
  }

  /**
   * Отримати скомпільований фільтр з кешу або створити новий
   */
  getCompiledFilter(source) {
    const cached = this.compiledFilters.get(source.id);
    
    if (cached !== undefined) {
      return cached;
    }

    return this.compileFilter(source.id, source.filters);
  }

  /**
   * Очистити кеш (викликати при зміні фільтрів або replacements)
   */
  clearCache(sourceId = null) {
    if (sourceId) {
      this.compiledFilters.delete(sourceId);
      this.compiledReplacements.delete(sourceId);
    } else {
      this.compiledFilters.clear();
      this.compiledReplacements.clear();
    }
  }

  /**
   * Препроцесинг тексту - застосування replacements
   * Викликається ПЕРЕД фільтрацією
   */
  preprocessText(compiledReplacements, messageText) {
    if (!messageText || typeof messageText !== 'string') {
      return messageText;
    }

    if (!compiledReplacements || compiledReplacements.patterns.length === 0) {
      return messageText;
    }

    let processedText = messageText;

    // Застосовуємо всі патерни послідовно
    for (const item of compiledReplacements.patterns) {
      if (item.type === 'regex') {
        processedText = processedText.replace(item.regex, item.replacement);
      } else {
        // string type - швидша заміна
        processedText = processedText.replaceAll(item.pattern, item.replacement);
      }
    }

    return processedText.trim();
  }

  /**
   * Швидка перевірка повідомлення з препроцесингом
   * Повертає true якщо повідомлення проходить фільтр
   * 
   * ОПТИМІЗАЦІЯ: Приймає вже скомпільовані replacements і filter
   */
  checkMessageFast(compiledReplacements, compiledFilter, messageText) {
    if (!messageText || typeof messageText !== 'string') {
      return false;
    }

    // Крок 1: Препроцесинг
    const processedText = this.preprocessText(compiledReplacements, messageText);

    // Крок 2: Фільтрація
    // Якщо фільтри вимкнені - пропускаємо все
    if (!compiledFilter) {
      return true;
    }

    const text = compiledFilter.caseSensitive 
      ? processedText 
      : processedText.toLowerCase();

    // ПРІОРИТЕТ 1: Перевіряємо blacklist (ранній вихід)
    if (compiledFilter.blacklist) {
      for (const word of compiledFilter.blacklist) {
        if (text.includes(word)) {
          return false; // Блокуємо одразу
        }
      }
    }

    // ПРІОРИТЕТ 2: Перевіряємо keywords
    if (compiledFilter.keywords) {
      for (const word of compiledFilter.keywords) {
        if (text.includes(word)) {
          return true; // Знайшли збіг - пропускаємо
        }
      }
      return false; // Немає збігів - блокуємо
    }

    // Якщо немає ні blacklist, ні keywords - пропускаємо
    return true;
  }

  /**
   * Розширена перевірка з деталями та препроцесингом
   */
  checkMessageDetailed(source, messageText) {
    if (!messageText || typeof messageText !== 'string') {
      return {
        passed: false,
        reason: 'Empty or invalid message',
        originalText: messageText,
        processedText: messageText
      };
    }

    const replacements = this.getCompiledReplacements(source);
    const processedText = this.preprocessText(replacements, messageText);

    const filter = this.getCompiledFilter(source);
    
    if (!filter) {
      return {
        passed: true,
        reason: 'Filters disabled',
        originalText: messageText,
        processedText: processedText
      };
    }

    const text = filter.caseSensitive 
      ? processedText 
      : processedText.toLowerCase();

    // Перевірка blacklist
    if (filter.blacklist) {
      for (const word of filter.blacklist) {
        if (text.includes(word)) {
          return {
            passed: false,
            reason: `Blocked by blacklist word: "${word}"`,
            originalText: messageText,
            processedText: processedText
          };
        }
      }
    }

    // Перевірка keywords
    if (filter.keywords) {
      for (const word of filter.keywords) {
        if (text.includes(word)) {
          return {
            passed: true,
            reason: `Matched keyword: "${word}"`,
            originalText: messageText,
            processedText: processedText
          };
        }
      }
      return {
        passed: false,
        reason: 'No keyword matches found',
        originalText: messageText,
        processedText: processedText
      };
    }

    return {
      passed: true,
      reason: 'No filters applied',
      originalText: messageText,
      processedText: processedText
    };
  }

  /**
   * Отримати статистику кешу
   */
  getCacheStats() {
    return {
      cachedFilters: this.compiledFilters.size,
      cachedReplacements: this.compiledReplacements.size
    };
  }
}

// Singleton для використання в усьому додатку
const messageFilter = new MessageFilter();
export default messageFilter;