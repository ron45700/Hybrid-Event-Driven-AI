// ============================================
// Aggregator Service (Synthesis Agent)
// The "Voice" of the Event-Sourced Architecture.
//
// Consumes:  conversation-events (SynthesizeFinalAnswerRequested)
// Produces:  conversation-events (FinalAnswerSynthesized)
//            bot_output_events   (Legacy BotResponseMessage for UI)
//
// Uses OpenAI to synthesize a natural language
// final answer from tool results.
// ============================================

import { OpenAI } from 'openai';
import { createProducer, createConsumer } from '../../shared/kafka-client';
import {
   TOPICS,
   ES_TOPICS,
   type BotResponseMessage,
} from '../../shared/kafka-topics';
import {
   SynthesizeFinalAnswerRequestedSchema,
   FinalAnswerSynthesizedSchema,
   type SynthesizeFinalAnswerRequested,
   type FinalAnswerSynthesized,
} from '../../shared/event-schemas';
import { SYNTHESIS_PROMPT } from './prompts';
import type { Producer, Consumer } from 'kafkajs';

// ============================================
// OpenAI Client
// ============================================
const openai = new OpenAI({
   apiKey: process.env.OPENAI_API_KEY,
});

let producer: Producer;
let consumer: Consumer;
let isRunning = false;

// ============================================
// Synthesis Logic
// ============================================

/**
 * Build the user message for OpenAI with the original query and tool results.
 */
function buildSynthesisInput(event: SynthesizeFinalAnswerRequested): string {
   const { originalQuery, toolResults } = event.payload;

   const resultsBlock = toolResults
      .map((r, i) => `Tool ${i + 1}: ${r.toolName}\nResult: ${r.result}`)
      .join('\n\n');

   return `Original Query: "${originalQuery}"\n\nTool Results:\n${resultsBlock}`;
}

/**
 * Call OpenAI to synthesize a final answer from tool results.
 */
async function synthesizeAnswer(
   event: SynthesizeFinalAnswerRequested
): Promise<string> {
   const userMessage = buildSynthesisInput(event);

   console.log(
      `🧠 Aggregator: Synthesizing answer for [${event.correlationId}]`
   );

   try {
      const response = await openai.chat.completions.create({
         model: 'gpt-4o-mini',
         messages: [
            { role: 'system', content: SYNTHESIS_PROMPT },
            { role: 'user', content: userMessage },
         ],
         temperature: 0.4,
         max_tokens: 800,
      });

      return (
         response.choices[0]?.message?.content?.trim() ||
         'I was unable to generate a response.'
      );
   } catch (error) {
      console.error('Aggregator: OpenAI synthesis error:', error);
      return 'Sorry, I encountered an error synthesizing the final response.';
   }
}

// ============================================
// Event Handler
// ============================================

async function handleSynthesizeRequest(
   event: SynthesizeFinalAnswerRequested
): Promise<void> {
   const { correlationId, payload } = event;

   console.log(
      `📥 Aggregator: Received SynthesizeFinalAnswerRequested [${correlationId}]`
   );

   const startTime = Date.now();

   // Synthesize the final answer via LLM
   const finalAnswer = await synthesizeAnswer(event);
   const durationMs = Date.now() - startTime;

   // 1. Emit FinalAnswerSynthesized → conversation-events
   const synthesizedEvent: FinalAnswerSynthesized = {
      eventType: 'FinalAnswerSynthesized',
      correlationId,
      timestamp: Date.now(),
      payload: {
         conversationId: payload.conversationId,
         finalAnswer,
      },
   };

   const validation = FinalAnswerSynthesizedSchema.safeParse(synthesizedEvent);
   if (!validation.success) {
      console.error(
         '❌ Aggregator: Invalid FinalAnswerSynthesized:',
         validation.error.format()
      );
      return;
   }

   await producer.send({
      topic: ES_TOPICS.CONVERSATION_EVENTS,
      messages: [
         {
            key: correlationId,
            value: JSON.stringify(synthesizedEvent),
         },
      ],
   });

   console.log(
      `📤 Aggregator: Published FinalAnswerSynthesized [${correlationId}] (${durationMs}ms)`
   );

   // 2. Legacy Support: Produce to bot_output_events for the React UI
   const legacyResponse: BotResponseMessage = {
      correlationId,
      timestamp: Date.now(),
      response: finalAnswer,
      sessionId: payload.conversationId,
   };

   await producer.send({
      topic: TOPICS.BOT_RESPONSES,
      messages: [{ value: JSON.stringify(legacyResponse) }],
   });

   console.log(
      `📤 Aggregator: Published legacy bot-response [${correlationId}]`
   );
}

// ============================================
// Message Router
// ============================================

async function routeEvent(raw: string): Promise<void> {
   let parsed: Record<string, unknown>;
   try {
      parsed = JSON.parse(raw);
   } catch {
      console.error('Aggregator: Received non-JSON message, skipping');
      return;
   }

   const eventType = parsed.eventType as string;

   switch (eventType) {
      case 'SynthesizeFinalAnswerRequested': {
         const validation =
            SynthesizeFinalAnswerRequestedSchema.safeParse(parsed);
         if (validation.success) {
            await handleSynthesizeRequest(
               validation.data as SynthesizeFinalAnswerRequested
            );
         } else {
            console.error(
               'Aggregator: Invalid SynthesizeFinalAnswerRequested:',
               validation.error.format()
            );
         }
         break;
      }
      // Events we don't care about — ignore silently
      case 'UserQueryReceived':
      case 'PlanGenerated':
      case 'ToolInvocationRequested':
      case 'ToolInvocationResulted':
      case 'PlanCompleted':
      case 'FinalAnswerSynthesized':
         break;
      default:
         break;
   }
}

// ============================================
// Service Lifecycle
// ============================================

async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 Aggregator: Starting (Synthesis Agent)...');

   producer = createProducer();
   consumer = createConsumer('aggregator-synthesis-group');

   await producer.connect();
   await consumer.connect();
   await consumer.subscribe({
      topic: ES_TOPICS.CONVERSATION_EVENTS,
      fromBeginning: false,
   });

   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;
         try {
            await routeEvent(message.value.toString());
         } catch (error) {
            console.error('Aggregator: Error processing event:', error);
         }
      },
   });

   isRunning = true;
   console.log(
      '✅ Aggregator: Running (listening on conversation-events for SynthesizeFinalAnswerRequested)'
   );
}

async function stop(): Promise<void> {
   console.log('🔌 Aggregator: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ Aggregator: Stopped');
}

export const aggregator = { start, stop };

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
