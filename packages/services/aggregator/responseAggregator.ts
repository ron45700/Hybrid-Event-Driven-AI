// ============================================
// Aggregator Service
// Consumes results from workers and violations
// from Guardrails, publishes final responses
// ============================================

import { createProducer, createConsumer } from '../shared/kafka-client';
import {
   TOPICS,
   type AppResultMessage,
   type BotResponseMessage,
   type GuardrailViolationMessage,
} from '../shared/kafka-topics';
import type { Producer, Consumer } from 'kafkajs';

let producer: Producer;
let resultConsumer: Consumer;
let violationConsumer: Consumer;
let isRunning = false;

/**
 * Start the Aggregator service
 */
async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 Aggregator: Starting...');

   producer = createProducer();
   resultConsumer = createConsumer('aggregator-result-group');
   violationConsumer = createConsumer('aggregator-violation-group');

   await producer.connect();

   // Subscribe to app-results
   await resultConsumer.connect();
   await resultConsumer.subscribe({
      topic: TOPICS.APP_RESULTS,
      fromBeginning: false,
   });

   // Subscribe to guardrail-violation-events
   await violationConsumer.connect();
   await violationConsumer.subscribe({
      topic: TOPICS.GUARDRAIL_VIOLATION,
      fromBeginning: false,
   });

   // Process app results from workers
   await resultConsumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const result: AppResultMessage = JSON.parse(
               message.value.toString()
            );
            console.log(
               `📥 Aggregator: Received result [${result.correlationId}] from "${result.source}"`
            );

            // Create final bot response
            const botResponse: BotResponseMessage = {
               correlationId: result.correlationId,
               timestamp: Date.now(),
               response: result.response,
               sessionId: result.sessionId,
            };

            // Publish to bot-responses (UserInterface consumes this)
            await producer.send({
               topic: TOPICS.BOT_RESPONSES,
               messages: [{ value: JSON.stringify(botResponse) }],
            });

            console.log(
               `📤 Aggregator: Published response [${result.correlationId}]`
            );
         } catch (error) {
            console.error('Aggregator: Error processing result:', error);
         }
      },
   });

   // Process guardrail violations (priority handling)
   await violationConsumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const violation: GuardrailViolationMessage = JSON.parse(
               message.value.toString()
            );
            console.log(
               `🚨 Aggregator: Received violation [${violation.correlationId}] type="${violation.violationType}"`
            );

            // Create rejection response
            const botResponse: BotResponseMessage = {
               correlationId: violation.correlationId,
               timestamp: Date.now(),
               response: violation.blockedReason,
               sessionId: violation.sessionId,
            };

            // Publish to bot-responses immediately
            await producer.send({
               topic: TOPICS.BOT_RESPONSES,
               messages: [{ value: JSON.stringify(botResponse) }],
            });

            console.log(
               `📤 Aggregator: Published violation response [${violation.correlationId}]`
            );
         } catch (error) {
            console.error('Aggregator: Error processing violation:', error);
         }
      },
   });

   isRunning = true;
   console.log('✅ Aggregator: Running');
}

/**
 * Stop the Aggregator service
 */
async function stop(): Promise<void> {
   console.log('🔌 Aggregator: Stopping...');
   await resultConsumer?.disconnect();
   await violationConsumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ Aggregator: Stopped');
}

export const aggregator = { start, stop };

// Run as standalone
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
