// ============================================
// End-to-End Flow Test Script
//
// Simulates the full event-sourced pipeline:
//  UserQueryReceived → PlanGenerated → ToolInvocationRequested
//  → ToolInvocationResulted → PlanCompleted
//  → SynthesizeFinalAnswerRequested → FinalAnswerSynthesized
//
// Run with: bun run packages/services/shared/test-full-flow.ts
// ============================================

import { createProducer, createConsumer } from './kafka-client';
import { ES_TOPICS } from './kafka-topics';
import type { Producer, Consumer } from 'kafkajs';

// ============================================
// Configuration
// ============================================
const TEST_QUERY = 'I need a laptop for gaming under $2000';
const CORRELATION_ID = crypto.randomUUID();
const CONVERSATION_ID = crypto.randomUUID();
const TIMEOUT_MS = 60_000; // 60 seconds max wait

// ============================================
// ANSI Colors for Terminal Output
// ============================================
const COLORS = {
   reset: '\x1b[0m',
   bright: '\x1b[1m',
   dim: '\x1b[2m',
   blue: '\x1b[34m',
   purple: '\x1b[35m',
   yellow: '\x1b[33m',
   green: '\x1b[32m',
   white: '\x1b[37m',
   cyan: '\x1b[36m',
   red: '\x1b[31m',
   bgBlue: '\x1b[44m',
   bgGreen: '\x1b[42m',
} as const;

function colorize(color: string, text: string): string {
   return `${color}${text}${COLORS.reset}`;
}

function timestamp(): string {
   return colorize(
      COLORS.dim,
      `[${new Date().toLocaleTimeString('en-US', { hour12: false })}]`
   );
}

function separator(): void {
   console.log(colorize(COLORS.dim, '─'.repeat(70)));
}

// ============================================
// Event Counters
// ============================================
let eventsReceived = 0;
const startTime = Date.now();

// ============================================
// Event Handlers (visualization only)
// ============================================

function handleUserQueryReceived(event: Record<string, unknown>): void {
   eventsReceived++;
   const payload = event.payload as Record<string, unknown>;
   console.log(
      `${timestamp()} 🔵 ${colorize(COLORS.bright + COLORS.blue, 'UserQueryReceived')}`
   );
   console.log(`   ${colorize(COLORS.dim, 'Query:')} "${payload.query}"`);
   console.log(
      `   ${colorize(COLORS.dim, 'CorrelationId:')} ${event.correlationId}`
   );
   separator();
}

function handlePlanGenerated(event: Record<string, unknown>): void {
   eventsReceived++;
   const payload = event.payload as Record<string, unknown>;
   const plan = payload.plan as Record<string, unknown>;
   const steps = plan.steps as Array<Record<string, unknown>>;

   console.log(
      `${timestamp()} 🟣 ${colorize(COLORS.bright + COLORS.purple, 'PlanGenerated')}`
   );
   console.log(`   ${colorize(COLORS.dim, 'PlanId:')} ${plan.planId}`);
   console.log(`   ${colorize(COLORS.dim, 'Steps:')} ${steps.length} total`);

   steps.forEach((step, i) => {
      const input = JSON.stringify(step.toolInput);
      const truncatedInput =
         input.length > 60 ? input.substring(0, 60) + '...' : input;
      console.log(
         `   ${colorize(COLORS.purple, `  [${i}]`)} ${colorize(COLORS.bright, String(step.toolName))} → ${colorize(COLORS.dim, truncatedInput)}`
      );
   });
   separator();
}

function handleToolInvocationRequested(event: Record<string, unknown>): void {
   eventsReceived++;
   const payload = event.payload as Record<string, unknown>;

   console.log(
      `${timestamp()} 🟡 ${colorize(COLORS.bright + COLORS.yellow, 'ToolInvocationRequested')}`
   );
   console.log(
      `   ${colorize(COLORS.dim, 'Tool:')} ${colorize(COLORS.bright + COLORS.yellow, String(payload.toolName))}`
   );
   console.log(`   ${colorize(COLORS.dim, 'Step:')} ${payload.stepIndex}`);
   separator();
}

function handleToolInvocationResulted(event: Record<string, unknown>): void {
   eventsReceived++;
   const payload = event.payload as Record<string, unknown>;
   const result = String(payload.result || '');
   const snippet =
      result.length > 120 ? result.substring(0, 120) + '...' : result;
   const statusIcon = payload.success ? '✅' : '❌';

   console.log(
      `${timestamp()} 🟢 ${colorize(COLORS.bright + COLORS.green, 'ToolInvocationResulted')}`
   );
   console.log(
      `   ${colorize(COLORS.dim, 'Tool:')} ${payload.toolName} ${statusIcon} (${payload.durationMs}ms)`
   );
   console.log(`   ${colorize(COLORS.dim, 'Result:')} ${snippet}`);
   separator();
}

function handlePlanCompleted(event: Record<string, unknown>): void {
   eventsReceived++;
   const payload = event.payload as Record<string, unknown>;
   const results = payload.results as Array<Record<string, unknown>>;

   console.log(
      `${timestamp()} ⚪ ${colorize(COLORS.bright + COLORS.cyan, 'PlanCompleted')}`
   );
   console.log(
      `   ${colorize(COLORS.dim, 'Total Duration:')} ${payload.totalDurationMs}ms`
   );
   console.log(
      `   ${colorize(COLORS.dim, 'Results:')} ${results.length} steps completed`
   );
   separator();
}

function handleSynthesizeRequested(event: Record<string, unknown>): void {
   eventsReceived++;
   const payload = event.payload as Record<string, unknown>;
   const results = payload.toolResults as Array<Record<string, unknown>>;

   console.log(
      `${timestamp()} 🔮 ${colorize(COLORS.bright + COLORS.purple, 'SynthesizeFinalAnswerRequested')}`
   );
   console.log(
      `   ${colorize(COLORS.dim, 'Tools to synthesize:')} ${results.map((r) => r.toolName).join(', ')}`
   );
   separator();
}

function handleFinalAnswerSynthesized(event: Record<string, unknown>): void {
   eventsReceived++;
   const payload = event.payload as Record<string, unknown>;
   const totalMs = Date.now() - startTime;

   console.log('');
   console.log(
      colorize(
         COLORS.bright + COLORS.green,
         '╔══════════════════════════════════════════════════════════════════════╗'
      )
   );
   console.log(
      colorize(
         COLORS.bright + COLORS.green,
         '║                    🎉 FINAL ANSWER RECEIVED 🎉                     ║'
      )
   );
   console.log(
      colorize(
         COLORS.bright + COLORS.green,
         '╚══════════════════════════════════════════════════════════════════════╝'
      )
   );
   console.log('');
   console.log(
      colorize(COLORS.bright + COLORS.white, String(payload.finalAnswer))
   );
   console.log('');
   separator();
   console.log(
      `${colorize(COLORS.dim, 'Total events observed:')} ${eventsReceived}`
   );
   console.log(`${colorize(COLORS.dim, 'End-to-end latency:')}   ${totalMs}ms`);
   separator();
}

// ============================================
// Main Flow
// ============================================

async function main(): Promise<void> {
   console.log('');
   console.log(
      colorize(
         COLORS.bright + COLORS.cyan,
         '╔══════════════════════════════════════════════════════════════════════╗'
      )
   );
   console.log(
      colorize(
         COLORS.bright + COLORS.cyan,
         '║          Event-Sourced Architecture — End-to-End Test              ║'
      )
   );
   console.log(
      colorize(
         COLORS.bright + COLORS.cyan,
         '╚══════════════════════════════════════════════════════════════════════╝'
      )
   );
   console.log('');
   console.log(`${colorize(COLORS.dim, 'Test Query:')}      "${TEST_QUERY}"`);
   console.log(`${colorize(COLORS.dim, 'CorrelationId:')}   ${CORRELATION_ID}`);
   console.log(
      `${colorize(COLORS.dim, 'ConversationId:')}  ${CONVERSATION_ID}`
   );
   console.log('');
   separator();

   // ---- 1. Set up Consumer (listen from beginning) ----
   const consumer: Consumer = createConsumer(`test-flow-${Date.now()}`);
   await consumer.connect();
   await consumer.subscribe({
      topic: ES_TOPICS.CONVERSATION_EVENTS,
      fromBeginning: true,
   });

   let resolved = false;

   const donePromise = new Promise<void>((resolve) => {
      consumer.run({
         eachMessage: async ({ message }) => {
            if (!message.value || resolved) return;

            try {
               const event = JSON.parse(message.value.toString()) as Record<
                  string,
                  unknown
               >;

               // Only show events for OUR test
               if (event.correlationId !== CORRELATION_ID) return;

               const eventType = event.eventType as string;

               switch (eventType) {
                  case 'UserQueryReceived':
                     handleUserQueryReceived(event);
                     break;
                  case 'PlanGenerated':
                     handlePlanGenerated(event);
                     break;
                  case 'ToolInvocationRequested':
                     handleToolInvocationRequested(event);
                     break;
                  case 'ToolInvocationResulted':
                     handleToolInvocationResulted(event);
                     break;
                  case 'PlanCompleted':
                     handlePlanCompleted(event);
                     break;
                  case 'SynthesizeFinalAnswerRequested':
                     handleSynthesizeRequested(event);
                     break;
                  case 'FinalAnswerSynthesized':
                     handleFinalAnswerSynthesized(event);
                     resolved = true;
                     setTimeout(() => resolve(), 2000);
                     break;
               }
            } catch {
               // Skip non-JSON or unrelated messages
            }
         },
      });
   });

   // ---- 2. Produce UserQueryReceived ----
   const producer: Producer = createProducer();
   await producer.connect();

   const userQueryEvent = {
      eventType: 'UserQueryReceived',
      correlationId: CORRELATION_ID,
      timestamp: Date.now(),
      payload: {
         userId: 'test-user',
         query: TEST_QUERY,
         conversationId: CONVERSATION_ID,
      },
   };

   // Small delay to let consumer settle
   await new Promise((r) => setTimeout(r, 1000));

   console.log(
      `${timestamp()} 📤 ${colorize(COLORS.bright, 'Sending UserQueryReceived')} → ${ES_TOPICS.USER_COMMANDS}`
   );
   separator();

   await producer.send({
      topic: ES_TOPICS.USER_COMMANDS,
      messages: [
         {
            key: CORRELATION_ID,
            value: JSON.stringify(userQueryEvent),
         },
      ],
   });

   // Also publish to conversation-events so the consumer picks it up
   await producer.send({
      topic: ES_TOPICS.CONVERSATION_EVENTS,
      messages: [
         {
            key: CORRELATION_ID,
            value: JSON.stringify(userQueryEvent),
         },
      ],
   });

   // ---- 3. Wait for completion or timeout ----
   const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(
         () =>
            reject(
               new Error(
                  `Timeout: No FinalAnswerSynthesized received within ${TIMEOUT_MS / 1000}s`
               )
            ),
         TIMEOUT_MS
      )
   );

   try {
      await Promise.race([donePromise, timeoutPromise]);
      console.log(
         `\n${colorize(COLORS.bright + COLORS.green, '✅ Test completed successfully!')}\n`
      );
   } catch (error) {
      console.error(
         `\n${colorize(COLORS.bright + COLORS.red, `❌ ${error}`)}\n`
      );
   }

   // ---- 4. Cleanup ----
   await consumer.disconnect();
   await producer.disconnect();
   process.exit(0);
}

main().catch((error) => {
   console.error('Fatal error:', error);
   process.exit(1);
});
