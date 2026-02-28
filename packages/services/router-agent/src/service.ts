// ============================================
// Router Agent Service
// Consumes UserQueryReceived from user-commands,
// generates a multi-step Plan via LLM,
// produces PlanGenerated to conversation-events.
// ============================================

import { OpenAI } from 'openai';
import { createProducer, createConsumer } from '../../shared/kafka-client';
import { ES_TOPICS } from '../../shared/kafka-topics';
import {
   UserQueryReceivedSchema,
   PlanGeneratedSchema,
   DeadLetterEventSchema,
   type UserQueryReceived,
   type PlanGenerated,
} from '../../shared/event-schemas';
import { PLAN_GENERATION_PROMPT } from './prompts';
import type { Producer, Consumer } from 'kafkajs';

// ============================================
// OpenAI Client
// ============================================
const openai = new OpenAI({
   apiKey: process.env.OPENAI_API_KEY,
});

// ============================================
// Kafka Connections
// ============================================
let producer: Producer;
let consumer: Consumer;
let isRunning = false;

// ============================================
// Plan ID Generator
// Uses crypto.randomUUID() (available in Bun natively)
// ============================================
function generatePlanId(): string {
   return crypto.randomUUID();
}

// ============================================
// LLM Plan Generation
// ============================================

/** Raw plan shape from the LLM (before wrapping into PlanGenerated) */
interface RawLLMPlan {
   steps: Array<{
      stepIndex: number;
      toolName: string;
      toolInput: Record<string, unknown>;
      dependsOn: number[];
   }>;
   totalSteps: number;
}

/**
 * Call OpenAI to generate an execution plan for the user's query.
 * Returns a validated PlanGenerated event or throws on failure.
 */
async function generatePlan(event: UserQueryReceived): Promise<PlanGenerated> {
   const { correlationId, payload } = event;
   const { query, conversationId } = payload;

   console.log(`🧠 RouterAgent: Generating plan for [${correlationId}]`);
   console.log(`   Query: "${query}"`);

   // Call LLM
   const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
         { role: 'system', content: PLAN_GENERATION_PROMPT },
         { role: 'user', content: query },
      ],
      temperature: 0,
      max_tokens: 1000,
      response_format: { type: 'json_object' },
   });

   const rawJson = response.choices[0]?.message?.content?.trim() || '';
   console.log(`🔍 RouterAgent: Raw LLM output: ${rawJson}`);

   // Parse raw JSON
   let rawPlan: RawLLMPlan;
   try {
      rawPlan = JSON.parse(rawJson) as RawLLMPlan;
   } catch {
      console.error(`❌ RouterAgent: LLM returned invalid JSON: ${rawJson}`);
      // Fallback: single general_chat step
      rawPlan = {
         steps: [
            {
               stepIndex: 0,
               toolName: 'general_chat',
               toolInput: { message: query },
               dependsOn: [],
            },
         ],
         totalSteps: 1,
      };
   }

   // Ensure totalSteps matches actual steps length
   rawPlan.totalSteps = rawPlan.steps.length;

   // Ensure stepIndex values are sequential
   rawPlan.steps = rawPlan.steps.map((step, idx) => ({
      ...step,
      stepIndex: idx,
      dependsOn: step.dependsOn || [],
   }));

   // Build the PlanGenerated event
   const planId = generatePlanId();
   const planGeneratedEvent: PlanGenerated = {
      eventType: 'PlanGenerated' as const,
      correlationId,
      timestamp: Date.now(),
      payload: {
         conversationId,
         originalQuery: query,
         plan: {
            planId,
            steps: rawPlan.steps.map((step) => ({
               stepIndex: step.stepIndex,
               toolName: step.toolName as
                  | 'math'
                  | 'weather'
                  | 'currency'
                  | 'rag'
                  | 'general_chat',
               toolInput: step.toolInput,
               dependsOn: step.dependsOn,
            })),
            totalSteps: rawPlan.totalSteps,
         },
      },
   };

   // Validate against Zod schema
   const validation = PlanGeneratedSchema.safeParse(planGeneratedEvent);
   if (!validation.success) {
      console.error(
         `❌ RouterAgent: Schema validation failed:`,
         validation.error.format()
      );
      // Fallback: wrap the query as a single general_chat step
      const fallbackEvent: PlanGenerated = {
         eventType: 'PlanGenerated' as const,
         correlationId,
         timestamp: Date.now(),
         payload: {
            conversationId,
            originalQuery: query,
            plan: {
               planId,
               steps: [
                  {
                     stepIndex: 0,
                     toolName: 'general_chat',
                     toolInput: { message: query },
                     dependsOn: [],
                  },
               ],
               totalSteps: 1,
            },
         },
      };
      console.log(`⚠️ RouterAgent: Falling back to single general_chat step`);
      return fallbackEvent;
   }

   return validation.data as PlanGenerated;
}

// ============================================
// Dead Letter Queue Helper
// ============================================

async function sendToDeadLetter(
   originalEvent: unknown,
   errorMessage: string
): Promise<void> {
   const dlqEvent = {
      originalTopic: ES_TOPICS.USER_COMMANDS,
      originalEvent,
      errorMessage,
      failedAt: Date.now(),
      serviceName: 'router-agent',
      retryCount: 0,
   };

   await producer.send({
      topic: ES_TOPICS.DEAD_LETTER_QUEUE,
      messages: [{ value: JSON.stringify(dlqEvent) }],
   });

   console.log(`📤 RouterAgent: Sent to dead-letter-queue: ${errorMessage}`);
}

// ============================================
// Service Lifecycle
// ============================================

async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 RouterAgent: Starting...');

   // Create Kafka connections
   producer = createProducer();
   consumer = createConsumer('router-agent-group');

   await producer.connect();
   await consumer.connect();
   await consumer.subscribe({
      topic: ES_TOPICS.CONVERSATION_EVENTS,
      fromBeginning: false,
   });

   // Process incoming UserQueryReceived events.
   // Note: We now consume from conversation-events (not user-commands).
   // The Guardrail Service is the gate — it validates and forwards
   // safe UserQueryReceived events here, and blocks unsafe ones.
   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         const raw = message.value.toString();
         let parsed: unknown;

         try {
            parsed = JSON.parse(raw);
         } catch {
            console.error('RouterAgent: Received non-JSON message, skipping');
            return;
         }

         // Only act on UserQueryReceived — silently ignore all other event types
         // (PlanGenerated, ToolInvocationResulted, PlanCompleted, QueryBlocked, etc.)
         const eventType = (parsed as Record<string, unknown>)?.eventType;
         if (eventType !== 'UserQueryReceived') return;

         // Validate incoming event
         const incomingValidation = UserQueryReceivedSchema.safeParse(parsed);
         if (!incomingValidation.success) {
            console.error(
               `❌ RouterAgent: Invalid UserQueryReceived event:`,
               incomingValidation.error.format()
            );
            await sendToDeadLetter(parsed, 'Invalid UserQueryReceived schema');
            return;
         }

         const userQuery = incomingValidation.data;
         console.log(`📥 RouterAgent: Received [${userQuery.correlationId}]`);

         try {
            // Generate plan via LLM
            const planEvent = await generatePlan(userQuery);

            // Produce PlanGenerated → conversation-events
            await producer.send({
               topic: ES_TOPICS.CONVERSATION_EVENTS,
               messages: [
                  {
                     key: planEvent.correlationId,
                     value: JSON.stringify(planEvent),
                  },
               ],
            });

            const stepSummary = planEvent.payload.plan.steps
               .map((s) => `${s.toolName}`)
               .join(' → ');

            console.log(
               `📤 RouterAgent: Published PlanGenerated [${planEvent.correlationId}] ` +
                  `planId=${planEvent.payload.plan.planId} ` +
                  `steps=${planEvent.payload.plan.totalSteps} (${stepSummary})`
            );
         } catch (error) {
            console.error('RouterAgent: Error generating plan:', error);
            await sendToDeadLetter(parsed, `Plan generation failed: ${error}`);
         }
      },
   });

   isRunning = true;
   console.log('✅ RouterAgent: Running — listening on "user-commands"');
}

async function stop(): Promise<void> {
   console.log('🔌 RouterAgent: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ RouterAgent: Stopped');
}

// Export service interface
export const routerAgent = { start, stop };

// Run as standalone service
if (import.meta.main) {
   start().catch(console.error);

   process.on('SIGINT', async () => {
      await stop();
      process.exit(0);
   });

   process.on('SIGTERM', async () => {
      await stop();
      process.exit(0);
   });
}
