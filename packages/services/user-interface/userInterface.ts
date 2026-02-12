// ============================================
// UserInterface Service
// Bridges the Express API with Kafka messaging
//
// GATEWAY SWITCH (Phase 7):
//   Producer → user-commands (UserQueryReceived)
//   Consumer → bot_output_events (Legacy, unchanged)
// ============================================

import { createProducer, createConsumer } from '../shared/kafka-client';
import {
   TOPICS,
   ES_TOPICS,
   type BotResponseMessage,
   type UserControlMessage,
} from '../shared/kafka-topics';
import type { UserQueryReceived } from '../shared/event-schemas';
import type { Producer, Consumer } from 'kafkajs';

// Pending response handlers (correlationId -> resolve function)
const pendingResponses = new Map<string, (response: string) => void>();

// Kafka connections
let producer: Producer;
let consumer: Consumer;
let isInitialized = false;

/**
 * Initialize Kafka connections
 */
async function initialize(): Promise<void> {
   if (isInitialized) return;

   console.log('🔌 UserInterface: Connecting to Kafka...');

   // Create and connect producer
   producer = createProducer();
   await producer.connect();

   // Create and connect consumer for bot responses (LEGACY — unchanged)
   consumer = createConsumer('user-interface-group');
   await consumer.connect();
   await consumer.subscribe({
      topic: TOPICS.BOT_RESPONSES,
      fromBeginning: false,
   });

   // Handle incoming responses
   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const response: BotResponseMessage = JSON.parse(
               message.value.toString()
            );
            const resolve = pendingResponses.get(response.correlationId);

            if (resolve) {
               resolve(response.response);
               pendingResponses.delete(response.correlationId);
            }
         } catch (error) {
            console.error('UserInterface: Failed to parse response:', error);
         }
      },
   });

   isInitialized = true;
   console.log('✅ UserInterface: Connected to Kafka');
}

/**
 * Send user message via the Event-Sourced pipeline and wait for response.
 *
 * Produces a `UserQueryReceived` event to `user-commands`.
 * The Aggregator will eventually produce the final answer to `bot_output_events`,
 * which our consumer above picks up and resolves the pending promise.
 *
 * @param prompt - User's message
 * @param conversationId - Conversation UUID
 * @param timeoutMs - Timeout in milliseconds (default: 45s)
 */
async function sendMessage(
   prompt: string,
   conversationId: string,
   timeoutMs: number = 45000
): Promise<string> {
   await initialize();

   const correlationId = crypto.randomUUID();

   // Create promise that resolves when response arrives
   const responsePromise = new Promise<string>((resolve, reject) => {
      pendingResponses.set(correlationId, resolve);

      setTimeout(() => {
         if (pendingResponses.has(correlationId)) {
            pendingResponses.delete(correlationId);
            reject(new Error('Response timeout'));
         }
      }, timeoutMs);
   });

   // Build UserQueryReceived event (matches Zod schema)
   const event: UserQueryReceived = {
      eventType: 'UserQueryReceived',
      correlationId,
      timestamp: Date.now(),
      payload: {
         userId: 'web-user',
         query: prompt,
         conversationId,
      },
   };

   // Produce to user-commands (the Router Agent's input topic)
   await producer.send({
      topic: ES_TOPICS.USER_COMMANDS,
      messages: [
         {
            key: correlationId,
            value: JSON.stringify(event),
         },
      ],
   });

   console.log(
      `📤 UserInterface: Sent UserQueryReceived [${correlationId}] → user-commands`
   );

   return responsePromise;
}

/**
 * Send reset control event
 * @param sessionId - Session identifier
 */
async function sendResetCommand(sessionId: string): Promise<void> {
   await initialize();

   const message: UserControlMessage = {
      correlationId: crypto.randomUUID(),
      timestamp: Date.now(),
      action: 'reset',
      sessionId,
   };

   await producer.send({
      topic: TOPICS.USER_CONTROL,
      messages: [{ value: JSON.stringify(message) }],
   });

   console.log('📤 UserInterface: Sent reset command');
}

/**
 * Graceful shutdown
 */
async function shutdown(): Promise<void> {
   console.log('🔌 UserInterface: Disconnecting...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isInitialized = false;
   console.log('✅ UserInterface: Disconnected');
}

// Export service interface
export const userInterfaceService = {
   initialize,
   sendMessage,
   sendResetCommand,
   shutdown,
};
