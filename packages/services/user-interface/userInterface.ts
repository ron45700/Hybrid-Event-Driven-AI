// ============================================
// UserInterface Service
// Bridges the Express API with Kafka messaging
// ============================================

import { createProducer, createConsumer } from '../shared/kafka-client';
import {
   TOPICS,
   type UserInputMessage,
   type BotResponseMessage,
   type UserControlMessage,
} from '../shared/kafka-topics';
import type { Producer, Consumer } from 'kafkajs';

// Pending response handlers (correlationId -> resolve function)
const pendingResponses = new Map<string, (response: string) => void>();

// Kafka connections
let producer: Producer;
let consumer: Consumer;
let isInitialized = false;

/**
 * Generate unique correlation ID
 */
function generateCorrelationId(): string {
   return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Initialize Kafka connections
 */
async function initialize(): Promise<void> {
   if (isInitialized) return;

   console.log('🔌 UserInterface: Connecting to Kafka...');

   // Create and connect producer
   producer = createProducer();
   await producer.connect();

   // Create and connect consumer for bot responses
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
 * Send user message and wait for response
 * @param prompt - User's message
 * @param sessionId - Session identifier
 * @param timeoutMs - Timeout in milliseconds (default: 30s)
 */
async function sendMessage(
   prompt: string,
   sessionId: string,
   timeoutMs: number = 30000
): Promise<string> {
   await initialize();

   const correlationId = generateCorrelationId();

   // Create promise that resolves when response arrives
   const responsePromise = new Promise<string>((resolve, reject) => {
      // Add to pending map
      pendingResponses.set(correlationId, resolve);

      // Set timeout
      setTimeout(() => {
         if (pendingResponses.has(correlationId)) {
            pendingResponses.delete(correlationId);
            reject(new Error('Response timeout'));
         }
      }, timeoutMs);
   });

   // Create and send message
   const message: UserInputMessage = {
      correlationId,
      timestamp: Date.now(),
      prompt,
      sessionId,
   };

   await producer.send({
      topic: TOPICS.USER_INPUT,
      messages: [{ value: JSON.stringify(message) }],
   });

   console.log(`📤 UserInterface: Sent message [${correlationId}]`);

   return responsePromise;
}

/**
 * Send reset control event
 * @param sessionId - Session identifier
 */
async function sendResetCommand(sessionId: string): Promise<void> {
   await initialize();

   const message: UserControlMessage = {
      correlationId: generateCorrelationId(),
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
