// ============================================
// GuardrailService
// Checks user input for forbidden topics
// Runs in parallel with Router
// ============================================

import { createProducer, createConsumer } from '../shared/kafka-client';
import {
   TOPICS,
   type UserInputMessage,
   type GuardrailViolationMessage,
} from '../shared/kafka-topics';
import { detectViolation } from './forbidden-topics';
import type { Producer, Consumer } from 'kafkajs';

// Kafka connections
let producer: Producer;
let consumer: Consumer;
let isRunning = false;

/**
 * Start the GuardrailService
 */
async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 GuardrailService: Starting...');

   // Create connections
   producer = createProducer();
   consumer = createConsumer('guardrail-service-group');

   await producer.connect();
   await consumer.connect();

   // Consume from user-input-events (parallel with Router)
   await consumer.subscribe({ topic: TOPICS.USER_INPUT, fromBeginning: false });

   // Process user input for violations
   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const input: UserInputMessage = JSON.parse(
               message.value.toString()
            );
            console.log(
               `📥 GuardrailService: Checking [${input.correlationId}]`
            );

            // Check for violations
            const violationType = detectViolation(input.prompt);

            if (violationType) {
               console.log(
                  `🚨 GuardrailService: VIOLATION detected [${violationType}] for [${input.correlationId}]`
               );

               // Create violation message
               const violationMessage: GuardrailViolationMessage = {
                  correlationId: input.correlationId,
                  timestamp: Date.now(),
                  originalPrompt: input.prompt,
                  violationType: violationType as
                     | 'politics'
                     | 'malware'
                     | 'inappropriate',
                  blockedReason: `I cannot process this request due to safety protocols.`,
                  sessionId: input.sessionId,
               };

               // Publish to guardrail_violation_events
               await producer.send({
                  topic: TOPICS.GUARDRAIL_VIOLATION,
                  messages: [{ value: JSON.stringify(violationMessage) }],
               });

               console.log(
                  `📤 GuardrailService: Published violation [${input.correlationId}] → guardrail_violation_events`
               );
            } else {
               console.log(
                  `✅ GuardrailService: Input is clean [${input.correlationId}]`
               );
               // No action needed - Router will process normally
            }
         } catch (error) {
            console.error('GuardrailService: Error processing message:', error);
         }
      },
   });

   isRunning = true;
   console.log('✅ GuardrailService: Running');
}

/**
 * Stop the GuardrailService
 */
async function stop(): Promise<void> {
   console.log('🔌 GuardrailService: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ GuardrailService: Stopped');
}

// Export service interface
export const guardrailService = {
   start,
   stop,
};

// Run as standalone service if executed directly
if (import.meta.main) {
   start().catch(console.error);

   // Graceful shutdown
   process.on('SIGINT', async () => {
      await stop();
      process.exit(0);
   });

   process.on('SIGTERM', async () => {
      await stop();
      process.exit(0);
   });
}
