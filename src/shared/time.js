/** Одиниці часу в мілісекундах — щоб у коді не жили `86_400_000` і `3_600_000`. */
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
