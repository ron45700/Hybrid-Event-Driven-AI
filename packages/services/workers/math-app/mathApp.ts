// ============================================
// MathApp Worker (Event-Sourced CQRS)
// Listens to: tool-invocation-requests (toolName="math")
// Produces to: conversation-events (ToolInvocationResulted)
// Business logic preserved: pure math + CoT word problems
// ============================================

import { OpenAI } from 'openai';
import { createProducer, createConsumer } from '../../shared/kafka-client';
import {
   TOPICS,
   ES_TOPICS,
   type CoTMathMessage,
} from '../../shared/kafka-topics';
import {
   ToolInvocationRequestedSchema,
   type ToolInvocationRequested,
   type ToolInvocationResulted,
} from '../../shared/event-schemas';
import { MATH_COT_PROMPT } from '../../shared/prompts';
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

const PURE_MATH_PATTERN = /^[\d+\-*/().\s]+$/;

function isWordProblem(expression: string): boolean {
   return !PURE_MATH_PATTERN.test(expression.trim());
}

async function extractExpressionFromWordProblem(
   wordProblem: string
): Promise<{ expression: string; reasoning: string }> {
   const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
         { role: 'system', content: MATH_COT_PROMPT },
         { role: 'user', content: wordProblem },
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
   });

   const content = response.choices[0]?.message?.content?.trim() || '';

   try {
      const parsed = JSON.parse(content);
      return {
         expression: parsed.expression || '',
         reasoning: parsed.reasoning || 'No reasoning provided',
      };
   } catch {
      console.error('MathApp: Failed to parse CoT response:', content);
      return { expression: '', reasoning: 'Failed to parse' };
   }
}

function calculateMath(expression: string): string {
   try {
      const sanitized = expression.replace(/\s/g, '');
      const validPattern = /^[\d+\-*/().]+$/;

      if (!validPattern.test(sanitized)) {
         return 'Error: Invalid characters in expression';
      }

      const result = new Function(`return (${sanitized})`)();

      if (typeof result !== 'number' || !isFinite(result)) {
         return 'Error: Invalid mathematical expression';
      }

      return `${expression} = ${result}`;
   } catch {
      return `Error: Could not evaluate "${expression}"`;
   }
}

// ============================================
// Event Handler (new CQRS pattern)
// ============================================

async function handleToolInvocation(
   event: ToolInvocationRequested
): Promise<void> {
   const { correlationId, payload } = event;
   const { planId, stepIndex, toolInput, conversationId } = payload;

   console.log(`📥 MathApp: Processing [${correlationId}] step=${stepIndex}`);

   const startTime = Date.now();
   let resultText = '';
   let success = true;
   let errorMessage: string | undefined;

   try {
      let expression = (toolInput as { expression?: string }).expression || '';
      let reasoning = '';

      // Chain-of-Thought for word problems
      if (isWordProblem(expression)) {
         console.log(`🧠 MathApp: Word problem detected, using CoT...`);
         const cot = await extractExpressionFromWordProblem(expression);
         reasoning = cot.reasoning;

         // Publish CoT audit event (legacy topic preserved)
         const cotMessage: CoTMathMessage = {
            correlationId,
            timestamp: Date.now(),
            originalProblem: expression,
            extractedExpression: cot.expression,
            reasoning: cot.reasoning,
            sessionId: conversationId,
         };

         await producer.send({
            topic: TOPICS.COT_MATH,
            messages: [{ value: JSON.stringify(cotMessage) }],
         });

         expression = cot.expression;
      }

      const calculationResult = calculateMath(expression);
      resultText = reasoning
         ? `${reasoning}\n\n${calculationResult}`
         : calculationResult;
   } catch (error) {
      success = false;
      errorMessage = `MathApp error: ${error}`;
      console.error(`❌ MathApp: ${errorMessage}`);
   }

   const durationMs = Date.now() - startTime;

   // Emit ToolInvocationResulted → conversation-events
   const resultEvent: ToolInvocationResulted = {
      eventType: 'ToolInvocationResulted',
      correlationId,
      timestamp: Date.now(),
      payload: {
         planId,
         stepIndex,
         toolName: 'math',
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
      `📤 MathApp: Published ToolInvocationResulted [${correlationId}] ` +
         `success=${success} duration=${durationMs}ms`
   );
}

// ============================================
// Service Lifecycle
// ============================================

async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 MathApp: Starting (CQRS mode)...');

   producer = createProducer();
   consumer = createConsumer('math-app-es-group');

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

            // Filter: only process math requests
            if (parsed.payload?.toolName !== 'math') return;

            const validation = ToolInvocationRequestedSchema.safeParse(parsed);
            if (!validation.success) {
               console.error(
                  'MathApp: Invalid event:',
                  validation.error.format()
               );
               return;
            }

            await handleToolInvocation(
               validation.data as ToolInvocationRequested
            );
         } catch (error) {
            console.error('MathApp: Error processing message:', error);
         }
      },
   });

   isRunning = true;
   console.log(
      '✅ MathApp: Running (CQRS — listening on tool-invocation-requests)'
   );
}

async function stop(): Promise<void> {
   console.log('🔌 MathApp: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ MathApp: Stopped');
}

export const mathApp = { start, stop };

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
