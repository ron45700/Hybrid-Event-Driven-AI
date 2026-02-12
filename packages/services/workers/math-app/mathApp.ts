// ============================================
// MathApp Worker
// Evaluates mathematical expressions
// Supports Chain-of-Thought for word problems
// ============================================

import { OpenAI } from 'openai';
import { createProducer, createConsumer } from '../../shared/kafka-client';
import {
   TOPICS,
   type FunctionExecutionRequest,
   type AppResultMessage,
   type CoTMathMessage,
} from '../../shared/kafka-topics';
import { MATH_COT_PROMPT } from '../../shared/prompts';
import type { Producer, Consumer } from 'kafkajs';

// Initialize OpenAI client
const openai = new OpenAI({
   apiKey: process.env.OPENAI_API_KEY,
});

let producer: Producer;
let consumer: Consumer;
let isRunning = false;

// Pattern to detect if input is a pure math expression
const PURE_MATH_PATTERN = /^[\d+\-*/().\s]+$/;

/**
 * Check if the expression is a word problem (contains words, not just math)
 */
function isWordProblem(expression: string): boolean {
   return !PURE_MATH_PATTERN.test(expression.trim());
}

/**
 * Use OpenAI to extract math expression from word problem (Chain of Thought)
 */
async function extractExpressionFromWordProblem(
   wordProblem: string
): Promise<{ expression: string; reasoning: string }> {
   const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
         {
            role: 'system',
            content: MATH_COT_PROMPT,
         },
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

/**
 * Safely evaluate a mathematical expression
 */
function calculateMath(expression: string): string {
   try {
      // Sanitize: only allow numbers, operators, parentheses, decimals
      const sanitized = expression.replace(/\s/g, '');
      const validPattern = /^[\d+\-*/().]+$/;

      if (!validPattern.test(sanitized)) {
         return 'Error: Invalid characters in expression';
      }

      // Use Function constructor for safe evaluation
      const result = new Function(`return (${sanitized})`)();

      if (typeof result !== 'number' || !isFinite(result)) {
         return 'Error: Invalid mathematical expression';
      }

      return `${expression} = ${result}`;
   } catch {
      return `Error: Could not evaluate "${expression}"`;
   }
}

/**
 * Start the MathApp worker
 */
async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 MathApp: Starting (with Chain-of-Thought)...');

   producer = createProducer();
   consumer = createConsumer('math-app-group');

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

            // Only process math requests
            if (execRequest.functionName !== 'math') return;

            console.log(
               `📥 MathApp: Processing [${execRequest.correlationId}]`
            );

            // Get expression from parameters
            let expression =
               (execRequest.parameters as { expression?: string }).expression ||
               '';
            let reasoning = '';

            // Check if it's a word problem → use Chain of Thought
            if (isWordProblem(expression)) {
               console.log(
                  `🧠 MathApp: Detected word problem, using Chain-of-Thought...`
               );
               console.log(`   Original: "${expression}"`);

               const cot = await extractExpressionFromWordProblem(expression);
               reasoning = cot.reasoning;

               console.log(`   Reasoning: ${cot.reasoning}`);
               console.log(`   Extracted: "${cot.expression}"`);

               // Publish CoT event for logging/auditing
               const cotMessage: CoTMathMessage = {
                  correlationId: execRequest.correlationId,
                  timestamp: Date.now(),
                  originalProblem: expression,
                  extractedExpression: cot.expression,
                  reasoning: cot.reasoning,
                  sessionId: execRequest.sessionId,
               };

               await producer.send({
                  topic: TOPICS.COT_MATH,
                  messages: [{ value: JSON.stringify(cotMessage) }],
               });

               console.log(
                  `📤 MathApp: Published CoT event → cot_math_expression_events`
               );

               // Use the extracted expression
               expression = cot.expression;
            }

            // Calculate the result
            const calculationResult = calculateMath(expression);

            // Build response with reasoning if CoT was used
            const response = reasoning
               ? `${reasoning}\n\n${calculationResult}`
               : calculationResult;

            // Publish result
            const result: AppResultMessage = {
               correlationId: execRequest.correlationId,
               timestamp: Date.now(),
               source: 'math',
               prompt: expression,
               response,
               sessionId: execRequest.sessionId,
            };

            await producer.send({
               topic: TOPICS.APP_RESULTS,
               messages: [{ value: JSON.stringify(result) }],
            });

            console.log(
               `📤 MathApp: Published result [${execRequest.correlationId}]`
            );
         } catch (error) {
            console.error('MathApp: Error processing message:', error);
         }
      },
   });

   isRunning = true;
   console.log('✅ MathApp: Running');
}

/**
 * Stop the MathApp worker
 */
async function stop(): Promise<void> {
   console.log('🔌 MathApp: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ MathApp: Stopped');
}

export const mathApp = { start, stop };

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
