// ============================================
// ExchangeApp Worker
// Returns currency exchange rates
// ============================================

import { createProducer, createConsumer } from '../../shared/kafka-client';
import {
   TOPICS,
   type FunctionExecutionRequest,
   type AppResultMessage,
} from '../../shared/kafka-topics';
import type { Producer, Consumer } from 'kafkajs';

// Static exchange rates (relative to USD)
const EXCHANGE_RATES = new Map<string, number>([
   ['USD', 1.0],
   ['EUR', 0.92],
   ['GBP', 0.79],
   ['ILS', 3.65],
   ['JPY', 149.5],
   ['CAD', 1.36],
   ['AUD', 1.53],
]);

let producer: Producer;
let consumer: Consumer;
let isRunning = false;

/**
 * Get exchange rate for a currency
 */
function getExchangeRate(currency: string): string {
   const code = currency.toUpperCase().trim();
   const rate = EXCHANGE_RATES.get(code);

   if (rate === undefined) {
      const available = Array.from(EXCHANGE_RATES.keys()).join(', ');
      return `Currency "${code}" not found. Available: ${available}`;
   }

   if (code === 'USD') {
      return `1 USD = 1.00 USD (base currency)`;
   }

   return `1 USD = ${rate} ${code}`;
}

/**
 * Start the ExchangeApp worker
 */
async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 ExchangeApp: Starting...');

   producer = createProducer();
   consumer = createConsumer('exchange-app-group');

   await producer.connect();
   await consumer.connect();
   await consumer.subscribe({
      topic: TOPICS.ENRICHED_EXECUTION,
      fromBeginning: false,
   });

   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const execRequest: FunctionExecutionRequest = JSON.parse(
               message.value.toString()
            );

            // Only process currency requests
            if (execRequest.functionName !== 'currency') return;

            console.log(
               `📥 ExchangeApp: Processing [${execRequest.correlationId}]`
            );

            // Get currency from parameters
            const currency =
               (execRequest.parameters as { currency?: string }).currency || '';
            const response = getExchangeRate(currency);

            // Publish result
            const result: AppResultMessage = {
               correlationId: execRequest.correlationId,
               timestamp: Date.now(),
               source: 'currency',
               prompt: currency,
               response,
               sessionId: execRequest.sessionId,
            };

            await producer.send({
               topic: TOPICS.APP_RESULTS,
               messages: [{ value: JSON.stringify(result) }],
            });

            console.log(
               `📤 ExchangeApp: Published result [${execRequest.correlationId}]`
            );
         } catch (error) {
            console.error('ExchangeApp: Error processing message:', error);
         }
      },
   });

   isRunning = true;
   console.log('✅ ExchangeApp: Running');
}

/**
 * Stop the ExchangeApp worker
 */
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
