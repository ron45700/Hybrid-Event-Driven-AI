// ============================================
// Forbidden Topics - Keyword Detection
// ============================================

/**
 * Political keywords to block
 */
export const POLITICAL_KEYWORDS = [
   'election',
   'elections',
   'government',
   'vote',
   'voting',
   'prime minister',
   'president',
   'politics',
   'political',
   'parliament',
   'netanyahu',
   'נתניהו',
   'בחירות',
   'ממשלה',
   'trump',
   'biden',
   'republican',
   'democrat',
];

/**
 * Malware/injection keywords to block
 */
export const MALWARE_KEYWORDS = [
   '<script>',
   '</script>',
   'drop table',
   'drop database',
   'delete from',
   'sql injection',
   'xss attack',
   'malware',
   'virus',
   'ransomware',
   'how to hack',
   'hack into',
   'exploit vulnerability',
   'create virus',
   'write malware',
];

/**
 * Check if input contains forbidden political content
 */
export function containsPolitics(input: string): boolean {
   const lowerInput = input.toLowerCase();
   return POLITICAL_KEYWORDS.some((keyword) =>
      lowerInput.includes(keyword.toLowerCase())
   );
}

/**
 * Check if input contains malware/injection content
 */
export function containsMalware(input: string): boolean {
   const lowerInput = input.toLowerCase();
   return MALWARE_KEYWORDS.some((keyword) =>
      lowerInput.includes(keyword.toLowerCase())
   );
}

/**
 * Check input for any violations
 * Returns the violation type or null if clean
 */
export function detectViolation(input: string): 'politics' | 'malware' | null {
   if (containsPolitics(input)) {
      return 'politics';
   }
   if (containsMalware(input)) {
      return 'malware';
   }
   return null;
}
