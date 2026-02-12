// ============================================
// Schema Validation Test Script
// Run: bun run packages/services/shared/test-schemas.ts
// ============================================

import {
   UserQueryReceivedSchema,
   PlanGeneratedSchema,
   ToolInvocationRequestedSchema,
   ToolInvocationResultedSchema,
   PlanCompletedSchema,
   SynthesizeFinalAnswerRequestedSchema,
   FinalAnswerSynthesizedSchema,
   DeadLetterEventSchema,
   parseConversationEvent,
   parseToolCommand,
} from './event-schemas';

const testUUID = '123e4567-e89b-12d3-a456-426614174000';
const now = Date.now();
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
   try {
      fn();
      console.log(`  ✅ ${name}`);
      passed++;
   } catch (error) {
      console.log(`  ❌ ${name}: ${error}`);
      failed++;
   }
}

function assert(condition: boolean, message: string): void {
   if (!condition) throw new Error(message);
}

console.log('\n🧪 Event Schema Validation Tests\n');

// --- 1. UserQueryReceived ---
console.log('📋 UserQueryReceived:');
test('valid event passes', () => {
   const result = UserQueryReceivedSchema.safeParse({
      eventType: 'UserQueryReceived',
      correlationId: 'corr-001',
      timestamp: now,
      payload: {
         userId: 'user-1',
         query: 'מה מזג האוויר בתל אביב?',
         conversationId: testUUID,
      },
   });
   assert(result.success, 'Should pass validation');
});

test('missing query fails', () => {
   const result = UserQueryReceivedSchema.safeParse({
      eventType: 'UserQueryReceived',
      correlationId: 'corr-001',
      timestamp: now,
      payload: { userId: 'user-1', conversationId: testUUID },
   });
   assert(!result.success, 'Should fail validation');
});

// --- 2. PlanGenerated ---
console.log('\n📋 PlanGenerated:');
test('single-step plan passes', () => {
   const result = PlanGeneratedSchema.safeParse({
      eventType: 'PlanGenerated',
      correlationId: 'corr-001',
      timestamp: now,
      payload: {
         conversationId: testUUID,
         originalQuery: 'What is 5+5?',
         plan: {
            planId: 'plan-001',
            steps: [
               {
                  stepIndex: 0,
                  toolName: 'math',
                  toolInput: { expression: '5+5' },
                  dependsOn: [],
               },
            ],
            totalSteps: 1,
         },
      },
   });
   assert(result.success, 'Should pass validation');
});

test('multi-step plan passes', () => {
   const result = PlanGeneratedSchema.safeParse({
      eventType: 'PlanGenerated',
      correlationId: 'corr-002',
      timestamp: now,
      payload: {
         conversationId: testUUID,
         originalQuery: 'מה מזג האוויר בתל אביב וכמה זה 5+5?',
         plan: {
            planId: 'plan-002',
            steps: [
               {
                  stepIndex: 0,
                  toolName: 'weather',
                  toolInput: { city: 'Tel Aviv' },
                  dependsOn: [],
               },
               {
                  stepIndex: 1,
                  toolName: 'math',
                  toolInput: { expression: '5+5' },
                  dependsOn: [],
               },
            ],
            totalSteps: 2,
         },
      },
   });
   assert(result.success, 'Should pass validation');
});

test('empty steps array fails', () => {
   const result = PlanGeneratedSchema.safeParse({
      eventType: 'PlanGenerated',
      correlationId: 'corr-003',
      timestamp: now,
      payload: {
         conversationId: testUUID,
         originalQuery: 'test',
         plan: { planId: 'plan-003', steps: [], totalSteps: 0 },
      },
   });
   assert(!result.success, 'Should fail — steps must have at least 1 item');
});

test('invalid toolName fails', () => {
   const result = PlanGeneratedSchema.safeParse({
      eventType: 'PlanGenerated',
      correlationId: 'corr-004',
      timestamp: now,
      payload: {
         conversationId: testUUID,
         originalQuery: 'test',
         plan: {
            planId: 'plan-004',
            steps: [
               {
                  stepIndex: 0,
                  toolName: 'invalid_tool',
                  toolInput: {},
                  dependsOn: [],
               },
            ],
            totalSteps: 1,
         },
      },
   });
   assert(!result.success, 'Should fail — invalid toolName');
});

// --- 3. ToolInvocationRequested ---
console.log('\n📋 ToolInvocationRequested:');
test('valid command passes', () => {
   const result = ToolInvocationRequestedSchema.safeParse({
      eventType: 'ToolInvocationRequested',
      correlationId: 'corr-001',
      timestamp: now,
      payload: {
         planId: 'plan-001',
         stepIndex: 0,
         toolName: 'weather',
         toolInput: { city: 'London' },
         conversationId: testUUID,
      },
   });
   assert(result.success, 'Should pass validation');
});

// --- 4. ToolInvocationResulted ---
console.log('\n📋 ToolInvocationResulted:');
test('successful result passes', () => {
   const result = ToolInvocationResultedSchema.safeParse({
      eventType: 'ToolInvocationResulted',
      correlationId: 'corr-001',
      timestamp: now,
      payload: {
         planId: 'plan-001',
         stepIndex: 0,
         toolName: 'weather',
         result: 'Tel Aviv: 22°C, sunny',
         success: true,
         durationMs: 150,
      },
   });
   assert(result.success, 'Should pass validation');
});

test('failed result with errorMessage passes', () => {
   const result = ToolInvocationResultedSchema.safeParse({
      eventType: 'ToolInvocationResulted',
      correlationId: 'corr-001',
      timestamp: now,
      payload: {
         planId: 'plan-001',
         stepIndex: 0,
         toolName: 'math',
         result: '',
         success: false,
         errorMessage: 'Division by zero',
         durationMs: 10,
      },
   });
   assert(result.success, 'Should pass validation');
});

// --- 5. PlanCompleted ---
console.log('\n📋 PlanCompleted:');
test('valid completion passes', () => {
   const result = PlanCompletedSchema.safeParse({
      eventType: 'PlanCompleted',
      correlationId: 'corr-001',
      timestamp: now,
      payload: {
         planId: 'plan-001',
         conversationId: testUUID,
         originalQuery: 'test query',
         results: [{ stepIndex: 0, toolName: 'math', result: '5+5 = 10' }],
         totalDurationMs: 300,
      },
   });
   assert(result.success, 'Should pass validation');
});

// --- 6. SynthesizeFinalAnswerRequested ---
console.log('\n📋 SynthesizeFinalAnswerRequested:');
test('valid synthesis request passes', () => {
   const result = SynthesizeFinalAnswerRequestedSchema.safeParse({
      eventType: 'SynthesizeFinalAnswerRequested',
      correlationId: 'corr-001',
      timestamp: now,
      payload: {
         planId: 'plan-001',
         conversationId: testUUID,
         originalQuery: 'test',
         toolResults: [{ toolName: 'math', result: '10' }],
      },
   });
   assert(result.success, 'Should pass validation');
});

// --- 7. FinalAnswerSynthesized ---
console.log('\n📋 FinalAnswerSynthesized:');
test('valid final answer passes', () => {
   const result = FinalAnswerSynthesizedSchema.safeParse({
      eventType: 'FinalAnswerSynthesized',
      correlationId: 'corr-001',
      timestamp: now,
      payload: {
         conversationId: testUUID,
         finalAnswer: 'The answer is 10.',
      },
   });
   assert(result.success, 'Should pass validation');
});

// --- 8. DeadLetterEvent ---
console.log('\n📋 DeadLetterEvent:');
test('valid dead letter passes', () => {
   const result = DeadLetterEventSchema.safeParse({
      originalTopic: 'conversation-events',
      originalEvent: { some: 'broken-data' },
      errorMessage: 'Schema validation failed',
      failedAt: now,
      serviceName: 'orchestrator',
      retryCount: 0,
   });
   assert(result.success, 'Should pass validation');
});

// --- 9. parseConversationEvent helper ---
console.log('\n📋 parseConversationEvent (JSON → typed event):');
test('valid JSON string parses correctly', () => {
   const raw = JSON.stringify({
      eventType: 'UserQueryReceived',
      correlationId: 'corr-001',
      timestamp: now,
      payload: { userId: 'u1', query: 'hello', conversationId: testUUID },
   });
   const result = parseConversationEvent(raw);
   assert(result.success, 'Should parse valid event');
});

test('invalid JSON returns error', () => {
   const result = parseConversationEvent('not-json{{{');
   assert(!result.success, 'Should fail on invalid JSON');
});

// --- 10. parseToolCommand helper ---
console.log('\n📋 parseToolCommand:');
test('valid tool command parses correctly', () => {
   const raw = JSON.stringify({
      eventType: 'ToolInvocationRequested',
      correlationId: 'corr-001',
      timestamp: now,
      payload: {
         planId: 'p1',
         stepIndex: 0,
         toolName: 'rag',
         toolInput: { query: 'search products' },
         conversationId: testUUID,
      },
   });
   const result = parseToolCommand(raw);
   assert(result.success, 'Should parse valid tool command');
});

// --- Summary ---
console.log(`\n${'='.repeat(40)}`);
console.log(
   `🧪 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`
);
console.log(`${'='.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
