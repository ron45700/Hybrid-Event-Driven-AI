// ============================================
// GeneralChatApp Worker (Event-Sourced CQRS)
// Listens to: tool-invocation-requests (toolName="general_chat")
// Produces to: conversation-events (ToolInvocationResulted)
// Business logic preserved: Cynical Data Engineer persona via OpenAI
// ============================================

import { OpenAI } from 'openai';
import { createProducer, createConsumer } from '../../shared/kafka-client';
import { ES_TOPICS } from '../../shared/kafka-topics';
import {
   ToolInvocationRequestedSchema,
   type ToolInvocationRequested,
   type ToolInvocationResulted,
} from '../../shared/event-schemas';
import { CYNICAL_ENGINEER_PROMPT } from '../../shared/prompts';
import type { Producer, Consumer } from 'kafkajs';

// Initialize OpenAI client
const openai = new OpenAI({
   apiKey: process.env.OPENAI_API_KEY,
});

let producer: Producer;
let consumer: Consumer;
let isRunning = false;

// ============================================
// Business Logic (preserved from original)
// ============================================

async function generateResponse(prompt: string): Promise<string> {
   try {
      const messages: Array<{
         role: 'user' | 'assistant' | 'system';
         content: string;
      }> = [
         { role: 'system', content: CYNICAL_ENGINEER_PROMPT },
         { role: 'user', content: prompt },
      ];

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

// ============================================
// Event Handler (new CQRS pattern)
// ============================================

async function handleToolInvocation(
   event: ToolInvocationRequested
): Promise<void> {
   const { correlationId, payload } = event;
   const { planId, stepIndex, toolInput } = payload;

   console.log(
      `📥 GeneralChatApp: Processing [${correlationId}] step=${stepIndex}`
   );

   const startTime = Date.now();
   let resultText = '';
   let success = true;
   let errorMessage: string | undefined;

   try {
      const userMessage = (toolInput as { message?: string }).message || '';
      resultText = await generateResponse(userMessage);
   } catch (error) {
      success = false;
      errorMessage = `GeneralChatApp error: ${error}`;
      console.error(`❌ GeneralChatApp: ${errorMessage}`);
   }

   const durationMs = Date.now() - startTime;

   const resultEvent: ToolInvocationResulted = {
      eventType: 'ToolInvocationResulted',
      correlationId,
      timestamp: Date.now(),
      payload: {
         planId,
         stepIndex,
         toolName: 'general_chat',
         result: resultText,
         success,
         durationMs,
         ...(errorMessage && { errorMessage }),
      },
   };

   await producer.send({
      topic: ES_TOPICS.CONVERSATION_EVENTS,
      messages: [{ key: correlationId, value: JSON.stringify(resultEvent) }],
   });

   console.log(
      `📤 GeneralChatApp: Published ToolInvocationResulted [${correlationId}] ` +
         `success=${success} duration=${durationMs}ms`
   );
}

// ============================================
// Service Lifecycle
// ============================================

async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 GeneralChatApp: Starting (CQRS mode)...');

   producer = createProducer();
   consumer = createConsumer('general-chat-es-group');

   await producer.connect();
   await consumer.connect();
   await consumer.subscribe({
      topic: ES_TOPICS.TOOL_INVOCATION_REQUESTS,
      fromBeginning: false,
   });

   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const parsed = JSON.parse(message.value.toString());

            if (parsed.payload?.toolName !== 'general_chat') return;

            const validation = ToolInvocationRequestedSchema.safeParse(parsed);
            if (!validation.success) {
               console.error(
                  'GeneralChatApp: Invalid event:',
                  validation.error.format()
               );
               return;
            }

            await handleToolInvocation(
               validation.data as ToolInvocationRequested
            );
         } catch (error) {
            console.error('GeneralChatApp: Error processing message:', error);
         }
      },
   });

   isRunning = true;
   console.log(
      '✅ GeneralChatApp: Running (CQRS — listening on tool-invocation-requests)'
   );
}

async function stop(): Promise<void> {
   console.log('🔌 GeneralChatApp: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ GeneralChatApp: Stopped');
}

export const generalChatApp = { start, stop };

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
