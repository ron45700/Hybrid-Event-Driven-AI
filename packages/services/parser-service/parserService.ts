// ============================================
// ParserService
// Validates LLM output and routes to Workers via Memory
// ============================================

import { createProducer, createConsumer } from '../shared/kafka-client';
import {
   TOPICS,
   type RouterDecisionMessage,
   type FunctionExecutionRequest,
   type ErrorEventMessage,
   type IntentType,
} from '../shared/kafka-topics';
import { getSchemaForIntent } from './schemas';
import type { Producer, Consumer } from 'kafkajs';

// Kafka connections
let producer: Producer;
let consumer: Consumer;
let isRunning = false;

/**
 * Validate and parse parameters based on intent type
 */
function validateParameters(
   intentType: IntentType,
   parametersJson: string
): { valid: boolean; parsed?: Record<string, unknown>; error?: string } {
   try {
      // Parse JSON string
      const rawParams = JSON.parse(parametersJson);

      // Get appropriate schema
      const schema = getSchemaForIntent(intentType);

      // Validate with Zod
      const result = schema.safeParse(rawParams);

      if (result.success) {
         return { valid: true, parsed: result.data as Record<string, unknown> };
      } else {
         const errorMessages = result.error.errors
            .map((e) => e.message)
            .join(', ');
         return { valid: false, error: errorMessages };
      }
   } catch (parseError) {
      return { valid: false, error: `JSON parse error: ${parseError}` };
   }
}

/**
 * Start the ParserService
 */
async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 ParserService: Starting...');

   // Create connections
   producer = createProducer();
   consumer = createConsumer('parser-service-group');

   await producer.connect();
   await consumer.connect();
   await consumer.subscribe({
      topic: TOPICS.ROUTER_DECISION,
      fromBeginning: false,
   });

   // Process router decision events
   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const decision: RouterDecisionMessage = JSON.parse(
               message.value.toString()
            );
            console.log(
               `📥 ParserService: Received [${decision.correlationId}] type="${decision.intentType}" confidence=${decision.confidence.toFixed(2)}`
            );

            // Validate parameters
            const validation = validateParameters(
               decision.intentType,
               decision.parameters
            );

            if (validation.valid && validation.parsed) {
               // Create function execution request
               const execRequest: FunctionExecutionRequest = {
                  correlationId: decision.correlationId,
                  timestamp: Date.now(),
                  functionName: decision.intentType,
                  parameters: validation.parsed,
                  sessionId: decision.sessionId,
               };

               // Publish to function_execution_requests (Memory will enrich)
               await producer.send({
                  topic: TOPICS.FUNCTION_EXECUTION,
                  messages: [{ value: JSON.stringify(execRequest) }],
               });

               console.log(
                  `✅ ParserService: Validated "${decision.intentType}" → function_execution_requests`
               );
            } else {
               // Publish error event
               const errorEvent: ErrorEventMessage = {
                  correlationId: decision.correlationId,
                  timestamp: Date.now(),
                  source: 'ParserService',
                  errorType: 'VALIDATION_ERROR',
                  errorMessage: validation.error || 'Unknown validation error',
                  sessionId: decision.sessionId,
               };

               await producer.send({
                  topic: TOPICS.ERROR_EVENTS,
                  messages: [{ value: JSON.stringify(errorEvent) }],
               });

               console.log(
                  `❌ ParserService: Validation failed for "${decision.intentType}": ${validation.error}`
               );
            }
         } catch (error) {
            console.error('ParserService: Error processing message:', error);
         }
      },
   });

   isRunning = true;
   console.log('✅ ParserService: Running');
}

/**
 * Stop the ParserService
 */
async function stop(): Promise<void> {
   console.log('🔌 ParserService: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ ParserService: Stopped');
}

// Export service interface
export const parserService = {
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
