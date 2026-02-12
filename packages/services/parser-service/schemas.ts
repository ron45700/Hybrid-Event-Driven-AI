// ============================================
// Zod Schemas for Intent Parameter Validation
// ============================================

import { z } from 'zod';

/**
 * Weather parameters schema
 */
export const WeatherParamsSchema = z.object({
   city: z.string().min(1, 'City name is required'),
});

/**
 * Math parameters schema
 */
export const MathParamsSchema = z.object({
   expression: z.string().min(1, 'Expression is required'),
});

/**
 * Currency parameters schema
 */
export const CurrencyParamsSchema = z.object({
   currency: z.string().length(3, 'Currency must be 3-letter ISO code'),
});

/**
 * General chat parameters schema
 */
export const GeneralParamsSchema = z.object({
   message: z.string().min(1, 'Message is required'),
});

/**
 * Get the appropriate schema for an intent type
 */
export function getSchemaForIntent(intentType: string) {
   switch (intentType) {
      case 'weather':
         return WeatherParamsSchema;
      case 'math':
         return MathParamsSchema;
      case 'currency':
         return CurrencyParamsSchema;
      case 'general':
         return GeneralParamsSchema;
      default:
         return GeneralParamsSchema;
   }
}

// Type exports for use in other services
export type WeatherParams = z.infer<typeof WeatherParamsSchema>;
export type MathParams = z.infer<typeof MathParamsSchema>;
export type CurrencyParams = z.infer<typeof CurrencyParamsSchema>;
export type GeneralParams = z.infer<typeof GeneralParamsSchema>;
