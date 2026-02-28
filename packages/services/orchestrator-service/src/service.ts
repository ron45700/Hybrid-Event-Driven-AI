// ============================================
// Orchestrator Service
// The "Heart" of the Event-Sourced Architecture.
//
// Consumes:  conversation-events (PlanGenerated, ToolInvocationResulted)
// Produces:  tool-invocation-requests (ToolInvocationRequested)
//            conversation-events     (PlanCompleted)
//
// On startup: replays conversation-events to rehydrate state.
// Then enters live mode: drives the Plan loop.
// ============================================

import { createProducer, createConsumer } from '../../shared/kafka-client';
import { ES_TOPICS } from '../../shared/kafka-topics';
import {
   PlanGeneratedSchema,
   ToolInvocationResultedSchema,
   ToolInvocationRequestedSchema,
   PlanCompletedSchema,
   SynthesizeFinalAnswerRequestedSchema,
   type PlanGenerated,
   type ToolInvocationResulted,
   type ToolInvocationRequested,
   type PlanCompleted,
   type SynthesizeFinalAnswerRequested,
} from '../../shared/event-schemas';
import { StateManager } from './state-manager';
import type { Producer, Consumer } from 'kafkajs';

// ============================================
// Service State
// ============================================

const stateManager = new StateManager();

let producer: Producer;
let consumer: Consumer;
let isRunning = false;

/** Cleanup interval handle */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/** Cleanup old completed plans every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
/** Plans older than 30 minutes get garbage collected */
const PLAN_MAX_AGE_MS = 30 * 60 * 1000;

// ============================================
// Command Dispatchers
// ============================================

/**
 * Dispatch the next ready step as a ToolInvocationRequested command.
 * Produces to `tool-invocation-requests`.
 */
async function dispatchNextStep(correlationId: string): Promise<void> {
   const state = stateManager.getState(correlationId);
   if (!state) return;

   const nextStep = stateManager.getNextReadyStep(correlationId);
   if (!nextStep) {
      console.log(`⏸️ Orchestrator: No ready steps for [${correlationId}]`);
      return;
   }

   const command: ToolInvocationRequested = {
      eventType: 'ToolInvocationRequested',
      correlationId,
      timestamp: Date.now(),
      payload: {
         planId: state.planId,
         stepIndex: nextStep.step.stepIndex,
         toolName: nextStep.step.toolName,
         toolInput: nextStep.step.toolInput,
         conversationId: state.conversationId,
      },
   };

   // Validate before producing (defensive)
   const validation = ToolInvocationRequestedSchema.safeParse(command);
   if (!validation.success) {
      console.error(
         `❌ Orchestrator: Invalid ToolInvocationRequested:`,
         validation.error.format()
      );
      return;
   }

   await producer.send({
      topic: ES_TOPICS.TOOL_INVOCATION_REQUESTS,
      messages: [
         {
            key: correlationId,
            value: JSON.stringify(command),
         },
      ],
   });

   // Mark dispatched in state
   stateManager.markStepDispatched(correlationId, nextStep.step.stepIndex);

   console.log(
      `📤 Orchestrator: Dispatched step ${nextStep.step.stepIndex} ` +
         `(${nextStep.step.toolName}) for [${correlationId}]`
   );
}

/**
 * Emit PlanCompleted + SynthesizeFinalAnswerRequested to conversation-events.
 */
async function emitPlanCompleted(correlationId: string): Promise<void> {
   const state = stateManager.getState(correlationId);
   if (!state) return;

   const results = stateManager.getCompletedResults(correlationId);
   const totalDuration = stateManager.getTotalDuration(correlationId);

   // 1. Emit PlanCompleted
   const planCompleted: PlanCompleted = {
      eventType: 'PlanCompleted',
      correlationId,
      timestamp: Date.now(),
      payload: {
         planId: state.planId,
         conversationId: state.conversationId,
         originalQuery: state.originalQuery,
         results,
         totalDurationMs: totalDuration,
      },
   };

   const pcValidation = PlanCompletedSchema.safeParse(planCompleted);
   if (!pcValidation.success) {
      console.error(
         `❌ Orchestrator: Invalid PlanCompleted:`,
         pcValidation.error.format()
      );
      return;
   }

   // 2. Emit SynthesizeFinalAnswerRequested
   const synthesizeRequest: SynthesizeFinalAnswerRequested = {
      eventType: 'SynthesizeFinalAnswerRequested',
      correlationId,
      timestamp: Date.now(),
      payload: {
         planId: state.planId,
         conversationId: state.conversationId,
         originalQuery: state.originalQuery,
         toolResults: results.map((r) => ({
            toolName: r.toolName,
            result: r.result,
         })),
      },
   };

   const sfValidation =
      SynthesizeFinalAnswerRequestedSchema.safeParse(synthesizeRequest);
   if (!sfValidation.success) {
      console.error(
         `❌ Orchestrator: Invalid SynthesizeFinalAnswerRequested:`,
         sfValidation.error.format()
      );
      return;
   }

   // Produce both events to conversation-events
   await producer.send({
      topic: ES_TOPICS.CONVERSATION_EVENTS,
      messages: [
         { key: correlationId, value: JSON.stringify(planCompleted) },
         { key: correlationId, value: JSON.stringify(synthesizeRequest) },
      ],
   });

   // Mark completed in state
   stateManager.markPlanCompleted(correlationId);

   const stepSummary = results.map((r) => `${r.toolName}✓`).join(', ');
   console.log(
      `🏁 Orchestrator: Plan [${correlationId}] COMPLETED ` +
         `(${totalDuration}ms) steps=[${stepSummary}]`
   );
}

// ============================================
// Event Handlers
// ============================================

/**
 * Handle a PlanGenerated event from conversation-events.
 */
async function handlePlanGenerated(event: PlanGenerated): Promise<void> {
   const isNew = stateManager.applyPlanGenerated(event);

   // During rehydration, only update state — don't dispatch commands
   if (stateManager.isRehydrating) return;

   // If not new (idempotent), skip
   if (!isNew) return;

   // Dispatch the first step
   await dispatchNextStep(event.correlationId);
}

/**
 * Handle a ToolInvocationResulted event from conversation-events.
 */
async function handleToolResult(event: ToolInvocationResulted): Promise<void> {
   const state = stateManager.applyToolResult(event);

   // During rehydration, only update state — don't dispatch commands
   if (stateManager.isRehydrating) return;

   if (!state) return;

   // Check: is the plan done?
   if (stateManager.isPlanDone(event.correlationId)) {
      await emitPlanCompleted(event.correlationId);
   } else {
      // More steps to go — dispatch the next one
      await dispatchNextStep(event.correlationId);
   }
}

// ============================================
// Message Router
// ============================================

/**
 * Route an incoming event from conversation-events to the correct handler.
 */
async function routeEvent(raw: string): Promise<void> {
   let parsed: Record<string, unknown>;
   try {
      parsed = JSON.parse(raw);
   } catch {
      console.error('Orchestrator: Received non-JSON message, skipping');
      return;
   }

   const eventType = parsed.eventType as string;

   switch (eventType) {
      case 'PlanGenerated': {
         const validation = PlanGeneratedSchema.safeParse(parsed);
         if (validation.success) {
            await handlePlanGenerated(validation.data as PlanGenerated);
         } else {
            console.error(
               'Orchestrator: Invalid PlanGenerated:',
               validation.error.format()
            );
         }
         break;
      }
      case 'ToolInvocationResulted': {
         const validation = ToolInvocationResultedSchema.safeParse(parsed);
         if (validation.success) {
            await handleToolResult(validation.data as ToolInvocationResulted);
         } else {
            console.error(
               'Orchestrator: Invalid ToolInvocationResulted:',
               validation.error.format()
            );
         }
         break;
      }
      // Events we emit but don't consume — ignore silently
      case 'UserQueryReceived':
      case 'PlanCompleted':
      case 'SynthesizeFinalAnswerRequested':
      case 'FinalAnswerSynthesized':
      case 'QueryBlocked': // Guardrail blocked this query — no plan to execute
         break;
      default:
         // Unknown event type — log and skip
         console.log(`Orchestrator: Ignoring unknown event type: ${eventType}`);
   }
}

// ============================================
// Rehydration
// ============================================

/**
 * Replay all events from conversation-events to rebuild state.
 * Uses a SEPARATE consumer group so it doesn't interfere with live processing.
 */
async function rehydrateState(): Promise<void> {
   console.log(
      '🔄 Orchestrator: Starting state rehydration from conversation-events...'
   );

   const rehydrationConsumer = createConsumer(
      'orchestrator-rehydration-' + Date.now()
   );
   await rehydrationConsumer.connect();
   await rehydrationConsumer.subscribe({
      topic: ES_TOPICS.CONVERSATION_EVENTS,
      fromBeginning: true,
   });

   stateManager.startRehydration();

   let eventCount = 0;

   // We need to detect when we've caught up to the end of the topic.
   // Strategy: consume until no new messages for 2 seconds.
   let lastMessageTime = Date.now();

   await new Promise<void>((resolve) => {
      const checkCaughtUp = setInterval(() => {
         if (Date.now() - lastMessageTime > 2000) {
            clearInterval(checkCaughtUp);
            resolve();
         }
      }, 500);

      rehydrationConsumer.run({
         eachMessage: async ({ message }) => {
            if (!message.value) return;
            lastMessageTime = Date.now();
            eventCount++;

            try {
               const raw = message.value.toString();
               await routeEvent(raw);
            } catch (error) {
               console.error('Orchestrator: Error during rehydration:', error);
            }
         },
      });

      // Safety: if the topic is empty, resolve after 3 seconds
      setTimeout(() => {
         clearInterval(checkCaughtUp);
         resolve();
      }, 3000);
   });

   stateManager.endRehydration();
   console.log(`🔄 Orchestrator: Replayed ${eventCount} events`);

   // Disconnect the rehydration consumer (it was single-use)
   await rehydrationConsumer.disconnect();

   // After rehydration, check for any active plans that need dispatch
   // (e.g., a plan was in-progress when the service crashed)
   const activePlans = stateManager.getActivePlans();
   if (activePlans.length > 0) {
      console.log(
         `🔁 Orchestrator: Resuming ${activePlans.length} active plan(s)...`
      );
      for (const plan of activePlans) {
         if (stateManager.isPlanDone(plan.correlationId)) {
            await emitPlanCompleted(plan.correlationId);
         } else {
            await dispatchNextStep(plan.correlationId);
         }
      }
   }
}

// ============================================
// Service Lifecycle
// ============================================

async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 Orchestrator: Starting...');

   // Create Kafka connections
   producer = createProducer();
   await producer.connect();

   // Phase 1: Rehydrate state from event log
   await rehydrateState();

   // Phase 2: Start live consumer
   consumer = createConsumer('orchestrator-service-group');
   await consumer.connect();
   await consumer.subscribe({
      topic: ES_TOPICS.CONVERSATION_EVENTS,
      fromBeginning: false, // Only new events from now on
   });

   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;
         try {
            await routeEvent(message.value.toString());
         } catch (error) {
            console.error('Orchestrator: Error processing event:', error);
         }
      },
   });

   // Start periodic cleanup of old completed plans
   cleanupInterval = setInterval(() => {
      stateManager.cleanupOldPlans(PLAN_MAX_AGE_MS);
   }, CLEANUP_INTERVAL_MS);

   isRunning = true;
   console.log('✅ Orchestrator: Running — listening on "conversation-events"');
}

async function stop(): Promise<void> {
   console.log('🔌 Orchestrator: Stopping...');

   if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
   }

   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ Orchestrator: Stopped');
}

// Export service interface
export const orchestrator = { start, stop };

// Run as standalone service
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
