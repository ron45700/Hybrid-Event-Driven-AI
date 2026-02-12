// ============================================
// RouterService
// Consumes user input, classifies intent, produces to router-intents
// ============================================

import { OpenAI } from 'openai';
import { createProducer, createConsumer } from '../shared/kafka-client';
import {
   TOPICS,
   type UserInputMessage,
   type RouterDecisionMessage,
   type LLMPromptMessage,
   type LLMResponseMessage,
   type IntentType,
} from '../shared/kafka-topics';
import { CLASSIFICATION_PROMPT_V2 } from '../shared/prompts';
import type { Producer, Consumer } from 'kafkajs';

// Initialize OpenAI client
const openai = new OpenAI({
   apiKey: process.env.OPENAI_API_KEY,
});

// Kafka connections
let producer: Producer;
let consumer: Consumer;
let isRunning = false;

// Structured parameters for type safety
interface ClassificationParameters {
   city?: string; // for weather
   expression?: string; // for math
   currency?: string; // for currency
   message?: string; // for general
}

interface ClassificationResult {
   type: IntentType;
   parameters: ClassificationParameters;
   confidence: number;
}

/**
 * Classify user intent using OpenAI
 * Publishes to llm_prompt_requests and llm_response_events for logging
 */
async function classifyIntent(
   prompt: string,
   correlationId: string,
   sessionId: string
): Promise<ClassificationResult> {
   // Publish prompt to llm_prompt_requests BEFORE calling LLM
   const promptMessage: LLMPromptMessage = {
      correlationId,
      timestamp: Date.now(),
      systemPrompt: CLASSIFICATION_PROMPT_V2,
      userPrompt: prompt,
      sessionId,
   };

   await producer.send({
      topic: TOPICS.LLM_PROMPT,
      messages: [{ value: JSON.stringify(promptMessage) }],
   });
   console.log(`📤 RouterService: Published prompt → llm_prompt_requests`);

   // Call OpenAI
   const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
         { role: 'system', content: CLASSIFICATION_PROMPT_V2 },
         { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
   });

   const rawJson = response.choices[0]?.message?.content?.trim() || '';

   // Log raw JSON response
   console.log(`🔍 RouterService: Raw LLM Response: ${rawJson}`);

   // Parse the response
   let classification: ClassificationResult;
   try {
      classification = JSON.parse(rawJson) as ClassificationResult;
   } catch {
      console.error('RouterService: Failed to parse classification:', rawJson);
      classification = {
         type: 'general',
         parameters: { message: prompt },
         confidence: 0.5,
      };
   }

   // Publish raw response to llm_response_events
   const responseMessage: LLMResponseMessage = {
      correlationId,
      timestamp: Date.now(),
      rawJson,
      intentType: classification.type,
      sessionId,
   };

   await producer.send({
      topic: TOPICS.LLM_RESPONSE,
      messages: [{ value: JSON.stringify(responseMessage) }],
   });
   console.log(`📤 RouterService: Published response → llm_response_events`);

   return classification;
}

/**
 * Start the RouterService
 */
async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 RouterService: Starting...');

   // Create connections
   producer = createProducer();
   consumer = createConsumer('router-service-group');

   await producer.connect();
   await consumer.connect();
   await consumer.subscribe({ topic: TOPICS.USER_INPUT, fromBeginning: false });

   // Process incoming messages
   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const input: UserInputMessage = JSON.parse(
               message.value.toString()
            );
            console.log(`📥 RouterService: Received [${input.correlationId}]`);

            // Classify intent (publishes to llm_prompt_requests and llm_response_events)
            const classification = await classifyIntent(
               input.prompt,
               input.correlationId,
               input.sessionId
            );
            console.log(
               `🎯 RouterService: Classified as "${classification.type}" (confidence: ${classification.confidence.toFixed(2)})`
            );

            // Create router decision message
            const decisionMessage: RouterDecisionMessage = {
               correlationId: input.correlationId,
               timestamp: Date.now(),
               prompt: input.prompt,
               intentType: classification.type,
               parameters: JSON.stringify(classification.parameters),
               confidence: classification.confidence,
               sessionId: input.sessionId,
            };

            // Publish to router_decision_events (Parser will validate)
            await producer.send({
               topic: TOPICS.ROUTER_DECISION,
               messages: [{ value: JSON.stringify(decisionMessage) }],
            });

            console.log(
               `📤 RouterService: Published decision [${input.correlationId}] → router_decision_events`
            );
         } catch (error) {
            console.error('RouterService: Error processing message:', error);
         }
      },
   });

   isRunning = true;
   console.log('✅ RouterService: Running');
}

/**
 * Stop the RouterService
 */
async function stop(): Promise<void> {
   console.log('🔌 RouterService: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ RouterService: Stopped');
}

// Export service interface
export const routerService = {
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
