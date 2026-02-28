// ============================================
// ExchangeApp Worker (ES Pipeline)
// Consumes: tool-invocation-requests  (toolName === 'currency')
// Produces: conversation-events       (ToolInvocationResulted)
// ============================================

import { createProducer, createConsumer } from '../../shared/kafka-client';
import { ES_TOPICS } from '../../shared/kafka-topics';
import {
   ToolInvocationRequestedSchema,
   type ToolInvocationRequested,
} from '../../shared/event-schemas';
import type { Producer, Consumer } from 'kafkajs';

// ============================================
// Static Exchange Rates (relative to USD)
// ============================================
const EXCHANGE_RATES = new Map<string, number>([
   ['USD', 1.0],
   ['EUR', 0.92],
   ['GBP', 0.79],
   ['ILS', 3.65],
   ['JPY', 149.5],
   ['CAD', 1.36],
   ['AUD', 1.53],
   ['CHF', 0.9],
   ['CNY', 7.24],
   ['INR', 83.1],
]);

const TOOL_NAME = 'currency' as const;

let producer: Producer;
let consumer: Consumer;
let isRunning = false;

// ============================================
// Business Logic
// ============================================

/**
 * Given a currency code, return a human-readable exchange rate string.
 */
function getExchangeRate(currency: string): string {
   const code = currency.toUpperCase().trim();
   const rate = EXCHANGE_RATES.get(code);

   if (rate === undefined) {
      const available = Array.from(EXCHANGE_RATES.keys()).join(', ');
      return `Currency "${code}" not found. Available currencies: ${available}`;
   }

   if (code === 'USD') {
      return `1 USD = 1.00 USD (USD is the base currency)`;
   }

   return `1 USD = ${rate} ${code}`;
}

// ============================================
// Service Lifecycle
// ============================================

async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 ExchangeApp: Starting (ES Pipeline)...');

   producer = createProducer();
   // Consume from the ES command channel
   consumer = createConsumer('exchange-app-group');

   await producer.connect();
   await consumer.connect();
   await consumer.subscribe({
      topic: ES_TOPICS.TOOL_INVOCATION_REQUESTS,
      fromBeginning: false,
   });

   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         let parsed: unknown;
         try {
            parsed = JSON.parse(message.value.toString());
         } catch {
            console.error('ExchangeApp: Received non-JSON message, skipping');
            return;
         }

         // Validate as a ToolInvocationRequested event
         const validation = ToolInvocationRequestedSchema.safeParse(parsed);
         if (!validation.success) {
            // Not our event type — silently skip (other workers will handle it)
            return;
         }

         const command: ToolInvocationRequested = validation.data;

         // Only handle currency requests
         if (command.payload.toolName !== TOOL_NAME) return;

         const { correlationId, payload } = command;
         const { planId, stepIndex, toolInput, conversationId } = payload;

         console.log(
            `📥 ExchangeApp: Processing currency step [${correlationId}] step=${stepIndex}`
         );

         const startTime = Date.now();
         let result: string;
         let success: boolean;
         let errorMessage: string | undefined;

         try {
            const currency =
               (toolInput as { currency?: string }).currency ?? '';
            result = getExchangeRate(currency);
            success = true;
            console.log(`💱 ExchangeApp: ${result}`);
         } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`❌ ExchangeApp: Error — ${msg}`);
            result = '';
            success = false;
            errorMessage = msg;
         }

         const durationMs = Date.now() - startTime;

         // Produce ToolInvocationResulted → conversation-events
         const resultEvent = {
            eventType: 'ToolInvocationResulted' as const,
            correlationId,
            timestamp: Date.now(),
            payload: {
               planId,
               stepIndex,
               toolName: TOOL_NAME,
               result,
               success,
               durationMs,
               ...(errorMessage && { errorMessage }),
            },
         };

         await producer.send({
            topic: ES_TOPICS.CONVERSATION_EVENTS,
            messages: [
               {
                  key: correlationId,
                  value: JSON.stringify(resultEvent),
               },
            ],
         });

         console.log(
            `📤 ExchangeApp: Published ToolInvocationResulted [${correlationId}] ` +
               `success=${success} duration=${durationMs}ms`
         );
      },
   });

   isRunning = true;
   console.log(
      '✅ ExchangeApp: Running — listening on "tool-invocation-requests"'
   );
}

async function stop(): Promise<void> {
   console.log('🔌 ExchangeApp: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ ExchangeApp: Stopped');
}

export const exchangeApp = { start, stop };

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
