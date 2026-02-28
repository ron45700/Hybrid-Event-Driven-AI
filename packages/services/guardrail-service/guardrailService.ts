// ============================================
// GuardrailService — Pipeline Gateway (ES Architecture)
//
// This service is the ENTRY POINT of the event pipeline.
// It acts as a gate between the UI and the Router Agent.
//
// Flow:
//   Consumes: user-commands         (UserQueryReceived from UI Gateway)
//   If SAFE:  conversation-events   (re-emits UserQueryReceived → Router picks it up)
//   If BLOCK: conversation-events   (emits QueryBlocked)
//             bot_output_events     (sends rejection BotResponseMessage → UI, no hang)
// ============================================

import { createProducer, createConsumer } from '../shared/kafka-client';
import {
   ES_TOPICS,
   TOPICS,
   type BotResponseMessage,
} from '../shared/kafka-topics';
import {
   UserQueryReceivedSchema,
   QueryBlockedSchema,
   type UserQueryReceived,
   type QueryBlocked,
} from '../shared/event-schemas';
import { detectViolation } from './forbidden-topics';
import type { Producer, Consumer } from 'kafkajs';

// Kafka connections
let producer: Producer;
let consumer: Consumer;
let isRunning = false;

// ============================================
// Rejection message sent to UI when a query is blocked
// ============================================
const REJECTION_MESSAGES: Record<string, string> = {
   politics:
      "🚫 I'm sorry, but I cannot discuss political topics. Please ask me about something else!",
   malware:
      "🚫 I'm sorry, but I cannot assist with that type of request. Please ask me something safe!",
   inappropriate:
      '🚫 That request has been flagged as inappropriate. Please rephrase your question.',
};

// ============================================
// Handlers
// ============================================

/**
 * Forward a clean UserQueryReceived event to conversation-events
 * so the Router Agent picks it up and generates a plan.
 */
async function forwardToRouter(event: UserQueryReceived): Promise<void> {
   await producer.send({
      topic: ES_TOPICS.CONVERSATION_EVENTS,
      messages: [
         {
            key: event.correlationId,
            value: JSON.stringify(event),
         },
      ],
   });

   console.log(
      `✅ GuardrailService: Forwarded [${event.correlationId}] → conversation-events`
   );
}

/**
 * Block the query: emit QueryBlocked to conversation-events AND
 * send a BotResponseMessage directly to bot_output_events so the
 * UI is notified immediately (no hang).
 */
async function blockQuery(
   event: UserQueryReceived,
   violationType: 'politics' | 'malware' | 'inappropriate'
): Promise<void> {
   const { correlationId, payload } = event;
   const reason: string =
      REJECTION_MESSAGES[violationType] ??
      '🚫 Your request cannot be processed due to our safety policies.';

   // 1. Emit QueryBlocked → conversation-events (audit trail / downstream awareness)
   const blockedEvent: QueryBlocked = {
      eventType: 'QueryBlocked',
      correlationId,
      timestamp: Date.now(),
      payload: {
         conversationId: payload.conversationId,
         originalQuery: payload.query,
         violationType,
         reason,
      },
   };

   const validation = QueryBlockedSchema.safeParse(blockedEvent);
   if (!validation.success) {
      console.error(
         '❌ GuardrailService: Invalid QueryBlocked event:',
         validation.error.format()
      );
      return;
   }

   // 2. Emit BotResponseMessage → bot_output_events (so the UI doesn't hang)
   const uiRejection: BotResponseMessage = {
      correlationId,
      timestamp: Date.now(),
      response: reason,
      sessionId: payload.conversationId,
   };

   // Produce both in a single batch for atomicity
   await producer.send({
      topic: ES_TOPICS.CONVERSATION_EVENTS,
      messages: [
         {
            key: correlationId,
            value: JSON.stringify(blockedEvent),
         },
      ],
   });

   await producer.send({
      topic: TOPICS.BOT_RESPONSES,
      messages: [
         {
            key: correlationId,
            value: JSON.stringify(uiRejection),
         },
      ],
   });

   console.log(
      `🚨 GuardrailService: BLOCKED [${correlationId}] ` +
         `violationType=${violationType} — rejection sent to UI`
   );
}

// ============================================
// Service Lifecycle
// ============================================

async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 GuardrailService: Starting (Pipeline Gateway)...');

   producer = createProducer();
   // Guardrail is the FIRST consumer of user-commands.
   // The Router Agent no longer subscribes to user-commands directly.
   consumer = createConsumer('guardrail-service-group');

   await producer.connect();
   await consumer.connect();

   // Consume from the ES user-commands topic (where the UI Gateway writes)
   await consumer.subscribe({
      topic: ES_TOPICS.USER_COMMANDS,
      fromBeginning: false,
   });

   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         let parsed: unknown;
         try {
            parsed = JSON.parse(message.value.toString());
         } catch {
            console.error(
               'GuardrailService: Received non-JSON message, skipping'
            );
            return;
         }

         // Validate as a UserQueryReceived event
         const validation = UserQueryReceivedSchema.safeParse(parsed);
         if (!validation.success) {
            console.error(
               '❌ GuardrailService: Invalid UserQueryReceived event:',
               validation.error.format()
            );
            return;
         }

         const event = validation.data;
         const { correlationId, payload } = event;

         console.log(
            `📥 GuardrailService: Checking [${correlationId}] ` +
               `query="${payload.query.substring(0, 60)}..."`
         );

         try {
            // Run the keyword-based guardrail check
            const violation = detectViolation(payload.query);

            if (violation) {
               // Blocked — do NOT forward to Router
               await blockQuery(
                  event,
                  violation as 'politics' | 'malware' | 'inappropriate'
               );
            } else {
               // Safe — forward to Router via conversation-events
               await forwardToRouter(event);
            }
         } catch (error) {
            console.error('GuardrailService: Error processing message:', error);
            // On error, fail safe: forward the event so the user isn't left hanging
            await forwardToRouter(event);
         }
      },
   });

   isRunning = true;
   console.log(
      '✅ GuardrailService: Running — gate on "user-commands" → "conversation-events"'
   );
}

async function stop(): Promise<void> {
   console.log('🔌 GuardrailService: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ GuardrailService: Stopped');
}

export const guardrailService = { start, stop };

// Run as standalone service if executed directly
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
