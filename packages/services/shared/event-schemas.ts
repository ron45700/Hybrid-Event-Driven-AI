// ============================================
// Event Schemas - Zod Validation for Event-Sourced Architecture
// Conceptual Schema Registry: every event must validate before production
// ============================================

import { z } from 'zod';

// ============================================
// Base Event Schema
// All events on `conversation-events` share this envelope
// ============================================

const BaseEventSchema = z.object({
   /** Discriminator — determines the payload shape */
   eventType: z.string(),
   /** End-to-end correlation ID (ties a user request to all downstream events) */
   correlationId: z.string().min(1),
   /** Unix epoch milliseconds */
   timestamp: z.number().int().positive(),
});

// ============================================
// 1. UserQueryReceived
// Produced by: UserInterface → conversation-events
// Consumed by: Router Agent
// ============================================

export const UserQueryReceivedSchema = BaseEventSchema.extend({
   eventType: z.literal('UserQueryReceived'),
   payload: z.object({
      userId: z.string().min(1),
      query: z.string().min(1),
      conversationId: z.string().uuid(),
   }),
});
export type UserQueryReceived = z.infer<typeof UserQueryReceivedSchema>;

// ============================================
// 2. PlanGenerated
// Produced by: Router Agent → conversation-events
// Consumed by: Orchestrator
// ============================================

const PlanStepSchema = z.object({
   stepIndex: z.number().int().min(0),
   toolName: z.enum(['math', 'weather', 'rag', 'general_chat']),
   toolInput: z.record(z.string(), z.unknown()),
   /** Indices of steps this step depends on (for future DAG support) */
   dependsOn: z.array(z.number().int().min(0)).default([]),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanGeneratedSchema = BaseEventSchema.extend({
   eventType: z.literal('PlanGenerated'),
   payload: z.object({
      conversationId: z.string().uuid(),
      originalQuery: z.string().min(1),
      plan: z.object({
         planId: z.string().min(1),
         steps: z.array(PlanStepSchema).min(1),
         totalSteps: z.number().int().positive(),
      }),
   }),
});
export type PlanGenerated = z.infer<typeof PlanGeneratedSchema>;

// ============================================
// 3. ToolInvocationRequested
// Produced by: Orchestrator → tool-invocation-requests
// Consumed by: Workers (Math, Weather, RAG, GeneralChat)
// ============================================

export const ToolInvocationRequestedSchema = BaseEventSchema.extend({
   eventType: z.literal('ToolInvocationRequested'),
   payload: z.object({
      planId: z.string().min(1),
      stepIndex: z.number().int().min(0),
      toolName: z.enum(['math', 'weather', 'rag', 'general_chat']),
      toolInput: z.record(z.string(), z.unknown()),
      conversationId: z.string().uuid(),
   }),
});
export type ToolInvocationRequested = z.infer<
   typeof ToolInvocationRequestedSchema
>;

// ============================================
// 4. ToolInvocationResulted
// Produced by: Workers → conversation-events
// Consumed by: Orchestrator
// ============================================

export const ToolInvocationResultedSchema = BaseEventSchema.extend({
   eventType: z.literal('ToolInvocationResulted'),
   payload: z.object({
      planId: z.string().min(1),
      stepIndex: z.number().int().min(0),
      toolName: z.enum(['math', 'weather', 'rag', 'general_chat']),
      result: z.string(),
      success: z.boolean(),
      errorMessage: z.string().optional(),
      durationMs: z.number().int().min(0),
   }),
});
export type ToolInvocationResulted = z.infer<
   typeof ToolInvocationResultedSchema
>;

// ============================================
// 5. PlanCompleted
// Produced by: Orchestrator → conversation-events
// Consumed by: Aggregator
// ============================================

const CompletedStepResultSchema = z.object({
   stepIndex: z.number().int().min(0),
   toolName: z.string().min(1),
   result: z.string(),
});

export const PlanCompletedSchema = BaseEventSchema.extend({
   eventType: z.literal('PlanCompleted'),
   payload: z.object({
      planId: z.string().min(1),
      conversationId: z.string().uuid(),
      originalQuery: z.string().min(1),
      results: z.array(CompletedStepResultSchema).min(1),
      totalDurationMs: z.number().int().min(0),
   }),
});
export type PlanCompleted = z.infer<typeof PlanCompletedSchema>;

// ============================================
// 6. SynthesizeFinalAnswerRequested
// Produced by: Orchestrator → conversation-events
// Consumed by: Aggregator
// ============================================

export const SynthesizeFinalAnswerRequestedSchema = BaseEventSchema.extend({
   eventType: z.literal('SynthesizeFinalAnswerRequested'),
   payload: z.object({
      planId: z.string().min(1),
      conversationId: z.string().uuid(),
      originalQuery: z.string().min(1),
      toolResults: z
         .array(
            z.object({
               toolName: z.string().min(1),
               result: z.string(),
            })
         )
         .min(1),
   }),
});
export type SynthesizeFinalAnswerRequested = z.infer<
   typeof SynthesizeFinalAnswerRequestedSchema
>;

// ============================================
// 7. FinalAnswerSynthesized
// Produced by: Aggregator → conversation-events
// Consumed by: UserInterface
// ============================================

export const FinalAnswerSynthesizedSchema = BaseEventSchema.extend({
   eventType: z.literal('FinalAnswerSynthesized'),
   payload: z.object({
      conversationId: z.string().uuid(),
      finalAnswer: z.string().min(1),
   }),
});
export type FinalAnswerSynthesized = z.infer<
   typeof FinalAnswerSynthesizedSchema
>;

// ============================================
// Discriminated Union: ConversationEvent
// Validates ANY event on the `conversation-events` topic
// ============================================

export const ConversationEventSchema = z.discriminatedUnion('eventType', [
   UserQueryReceivedSchema,
   PlanGeneratedSchema,
   ToolInvocationResultedSchema,
   PlanCompletedSchema,
   SynthesizeFinalAnswerRequestedSchema,
   FinalAnswerSynthesizedSchema,
]);
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;

/**
 * The ToolInvocationRequested event lives on its OWN topic
 * (`tool-invocation-requests`), not on `conversation-events`.
 * This is the CQRS command channel.
 */
export const ToolCommandSchema = ToolInvocationRequestedSchema;
export type ToolCommand = z.infer<typeof ToolCommandSchema>;

// ============================================
// Dead Letter Queue Event
// Failed messages that could not be processed
// ============================================

export const DeadLetterEventSchema = z.object({
   originalTopic: z.string().min(1),
   originalEvent: z.unknown(),
   errorMessage: z.string(),
   failedAt: z.number().int().positive(),
   serviceName: z.string().min(1),
   retryCount: z.number().int().min(0).default(0),
});
export type DeadLetterEvent = z.infer<typeof DeadLetterEventSchema>;

// ============================================
// Validation Helpers
// ============================================

/**
 * Validate and parse a raw JSON string from Kafka into a typed ConversationEvent.
 * Returns { success: true, data } or { success: false, error }.
 */
export function parseConversationEvent(
   raw: string
): z.SafeParseReturnType<unknown, ConversationEvent> {
   try {
      const parsed = JSON.parse(raw);
      return ConversationEventSchema.safeParse(parsed);
   } catch {
      return {
         success: false,
         error: new z.ZodError([
            {
               code: 'custom',
               path: [],
               message: `Invalid JSON: ${raw.substring(0, 100)}`,
            },
         ]),
      } as z.SafeParseReturnType<unknown, ConversationEvent>;
   }
}

/**
 * Validate and parse a raw JSON string into a ToolInvocationRequested command.
 */
export function parseToolCommand(
   raw: string
): z.SafeParseReturnType<unknown, ToolCommand> {
   try {
      const parsed = JSON.parse(raw);
      return ToolCommandSchema.safeParse(parsed);
   } catch {
      return {
         success: false,
         error: new z.ZodError([
            {
               code: 'custom',
               path: [],
               message: `Invalid JSON: ${raw.substring(0, 100)}`,
            },
         ]),
      } as z.SafeParseReturnType<unknown, ToolCommand>;
   }
}
