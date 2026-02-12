// ============================================
// MemoryService
// Manages conversation history and enriches intents
// ============================================

import { existsSync, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { createProducer, createConsumer } from '../shared/kafka-client';
import {
   TOPICS,
   type FunctionExecutionRequest,
   type AppResultMessage,
   type UserControlMessage,
} from '../shared/kafka-topics';
import type { Producer, Consumer } from 'kafkajs';

// ============================================
// History Storage (Bun File API)
// Points to packages/server/data/history.json
// ============================================

// Navigate from services/memory-service to server/data
const DATA_DIR = path.resolve(import.meta.dir, '..', '..', 'server', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

/** Chat message structure */
export interface ChatMessage {
   role: 'system' | 'user' | 'assistant';
   content: string;
}

/** Ensure data directory exists */
function ensureDataDir(): void {
   if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
   }
}

/** Load chat history from file */
async function loadHistory(): Promise<ChatMessage[]> {
   const file = Bun.file(HISTORY_FILE);
   const exists = await file.exists();

   if (!exists) {
      return [];
   }

   try {
      return await file.json();
   } catch (error) {
      console.error('MemoryService: Error parsing history:', error);
      return [];
   }
}

/** Save chat history to file */
async function saveHistory(messages: ChatMessage[]): Promise<void> {
   ensureDataDir();
   await Bun.write(HISTORY_FILE, JSON.stringify(messages, null, 2));
}

/** Reset chat history */
async function resetHistory(): Promise<void> {
   const file = Bun.file(HISTORY_FILE);
   const exists = await file.exists();

   if (exists) {
      await unlink(HISTORY_FILE);
   }
   console.log('🗑️ MemoryService: History reset');
}

/**
 * Check and log history status on startup
 */
async function checkHistoryOnStartup(): Promise<void> {
   const history = await loadHistory();

   if (history.length === 0) {
      console.log(
         '📜 MemoryService: No previous history found. Starting a fresh session.'
      );
   } else {
      console.log(
         `🧠 MemoryService: Existing history detected. Conversation context loaded for the user. (${history.length} messages)`
      );
   }
}

// ============================================
// Kafka Integration
// ============================================

let producer: Producer;
let intentConsumer: Consumer;
let resultConsumer: Consumer;
let controlConsumer: Consumer;
let isRunning = false;

/**
 * Start the MemoryService
 */
async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 MemoryService: Starting...');

   // Check for existing history and log status
   await checkHistoryOnStartup();

   // Create connections
   producer = createProducer();
   intentConsumer = createConsumer('memory-service-intent-group');
   resultConsumer = createConsumer('memory-service-result-group');
   controlConsumer = createConsumer('memory-service-control-group');

   await producer.connect();

   // Subscribe to function_execution_requests (from ParserService)
   await intentConsumer.connect();
   await intentConsumer.subscribe({
      topic: TOPICS.FUNCTION_EXECUTION,
      fromBeginning: false,
   });

   // Subscribe to app-results (to update history)
   await resultConsumer.connect();
   await resultConsumer.subscribe({
      topic: TOPICS.APP_RESULTS,
      fromBeginning: false,
   });

   // Subscribe to user-control-events (for reset commands)
   await controlConsumer.connect();
   await controlConsumer.subscribe({
      topic: TOPICS.USER_CONTROL,
      fromBeginning: false,
   });

   // Process function execution requests: enrich with history for general chat
   await intentConsumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const execRequest: FunctionExecutionRequest = JSON.parse(
               message.value.toString()
            );
            console.log(
               `📥 MemoryService: Received [${execRequest.correlationId}] function="${execRequest.functionName}"`
            );

            // Only enrich general chat with history
            if (execRequest.functionName === 'general') {
               const history = await loadHistory();
               execRequest.history = history;
               console.log(
                  `📚 MemoryService: Attached ${history.length} history messages`
               );
            }

            // Publish to enriched_execution_requests (Workers consume this)
            await producer.send({
               topic: TOPICS.ENRICHED_EXECUTION,
               messages: [{ value: JSON.stringify(execRequest) }],
            });

            console.log(
               `📤 MemoryService: Published enriched request [${execRequest.correlationId}] → enriched_execution_requests`
            );
         } catch (error) {
            console.error('MemoryService: Error processing request:', error);
         }
      },
   });

   // Process app-results: update history with prompt and response
   await resultConsumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const result: AppResultMessage = JSON.parse(
               message.value.toString()
            );
            console.log(
               `📥 MemoryService: Received result [${result.correlationId}] from "${result.source}"`
            );

            // Load current history
            const history = await loadHistory();

            // Append user message
            history.push({ role: 'user', content: result.prompt });

            // Append assistant response
            history.push({ role: 'assistant', content: result.response });

            // Save updated history
            await saveHistory(history);

            console.log(
               `💾 MemoryService: Saved history (${history.length} messages)`
            );
         } catch (error) {
            console.error('MemoryService: Error processing result:', error);
         }
      },
   });

   // Process control events: handle reset
   await controlConsumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const control: UserControlMessage = JSON.parse(
               message.value.toString()
            );
            console.log(
               `📥 MemoryService: Received control [${control.action}]`
            );

            if (control.action === 'reset') {
               await resetHistory();
            }
         } catch (error) {
            console.error('MemoryService: Error processing control:', error);
         }
      },
   });

   isRunning = true;
   console.log('✅ MemoryService: Running');
}

/**
 * Stop the MemoryService
 */
async function stop(): Promise<void> {
   console.log('🔌 MemoryService: Stopping...');
   await intentConsumer?.disconnect();
   await resultConsumer?.disconnect();
   await controlConsumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ MemoryService: Stopped');
}

// Export service interface
export const memoryService = {
   start,
   stop,
   loadHistory,
   saveHistory,
   resetHistory,
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
