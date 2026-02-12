// ============================================
// GeneralChatApp Worker
// Handles general conversation with OpenAI
// ============================================

import { OpenAI } from 'openai';
import { createProducer, createConsumer } from '../../shared/kafka-client';
import {
   TOPICS,
   type FunctionExecutionRequest,
   type AppResultMessage,
} from '../../shared/kafka-topics';
import { CYNICAL_ENGINEER_PROMPT } from '../../shared/prompts';
import type { Producer, Consumer } from 'kafkajs';

// Initialize OpenAI client
const openai = new OpenAI({
   apiKey: process.env.OPENAI_API_KEY,
});

let producer: Producer;
let consumer: Consumer;
let isRunning = false;

/**
 * Generate response using OpenAI with conversation history
 */
async function generateResponse(
   prompt: string,
   history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
): Promise<string> {
   try {
      // Log history being used
      console.log(
         `📚 GeneralChatApp: Using ${history.length} history messages for context`
      );

      // Build messages array with history
      const messages: Array<{
         role: 'user' | 'assistant' | 'system';
         content: string;
      }> = [
         { role: 'system', content: CYNICAL_ENGINEER_PROMPT },
         ...history,
         { role: 'user', content: prompt },
      ];

      console.log(
         `📝 GeneralChatApp: Total messages in context: ${messages.length}`
      );

      const response = await openai.chat.completions.create({
         model: 'gpt-4o-mini',
         messages,
         temperature: 0.7,
         max_tokens: 500,
      });

      return (
         response.choices[0]?.message?.content?.trim() ||
         'No response generated.'
      );
   } catch (error) {
      console.error('GeneralChatApp: OpenAI error:', error);
      return 'Sorry, I encountered an error processing your request.';
   }
}

/**
 * Start the GeneralChatApp worker
 */
async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 GeneralChatApp: Starting...');

   producer = createProducer();
   consumer = createConsumer('general-chat-app-group');

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

            // Only process general requests
            if (execRequest.functionName !== 'general') return;

            console.log(
               `📥 GeneralChatApp: Processing [${execRequest.correlationId}]`
            );

            // Get message from parameters
            const userMessage =
               (execRequest.parameters as { message?: string }).message || '';

            // Generate response with history
            const response = await generateResponse(
               userMessage,
               execRequest.history || []
            );

            // Publish result
            const result: AppResultMessage = {
               correlationId: execRequest.correlationId,
               timestamp: Date.now(),
               source: 'general',
               prompt: userMessage,
               response,
               sessionId: execRequest.sessionId,
            };

            await producer.send({
               topic: TOPICS.APP_RESULTS,
               messages: [{ value: JSON.stringify(result) }],
            });

            console.log(
               `📤 GeneralChatApp: Published result [${execRequest.correlationId}]`
            );
         } catch (error) {
            console.error('GeneralChatApp: Error processing message:', error);
         }
      },
   });

   isRunning = true;
   console.log('✅ GeneralChatApp: Running');
}

/**
 * Stop the GeneralChatApp worker
 */
async function stop(): Promise<void> {
   console.log('🔌 GeneralChatApp: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ GeneralChatApp: Stopped');
}

export const generalChatApp = { start, stop };

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
