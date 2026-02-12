// ============================================
// State Manager — In-Memory Event-Sourced State Store
// Manages Plan execution state per correlationId.
// Supports rehydration from Kafka event replay.
// ============================================

import type {
   PlanGenerated,
   ToolInvocationResulted,
   PlanStep,
} from '../../shared/event-schemas';

// ============================================
// State Types
// ============================================

/** Status of an individual step within a plan */
export type StepStatus = 'pending' | 'dispatched' | 'completed' | 'failed';

/** State of a single plan step, enriched with runtime data */
export interface StepState {
   /** Step definition from the plan */
   step: PlanStep;
   /** Current status */
   status: StepStatus;
   /** Result from the worker (populated on completion) */
   result?: string;
   /** Error message if the step failed */
   errorMessage?: string;
   /** Duration in ms (populated on completion) */
   durationMs?: number;
   /** Timestamp when the step was dispatched */
   dispatchedAt?: number;
   /** Timestamp when the step completed */
   completedAt?: number;
}

/** Lifecycle phase of the entire plan */
export type PlanPhase = 'initialized' | 'executing' | 'completed';

/** Full state of a plan execution */
export interface PlanState {
   /** Unique plan identifier */
   planId: string;
   /** End-to-end correlation ID */
   correlationId: string;
   /** Conversation grouping ID */
   conversationId: string;
   /** Original user query */
   originalQuery: string;
   /** Current lifecycle phase */
   phase: PlanPhase;
   /** State of each step, indexed by stepIndex */
   steps: StepState[];
   /** Total number of steps */
   totalSteps: number;
   /** Timestamp when the plan was initialized */
   createdAt: number;
   /** Timestamp of the last state update */
   updatedAt: number;
}

// ============================================
// State Manager Class
// ============================================

export class StateManager {
   /** In-memory state store: correlationId → PlanState */
   private store = new Map<string, PlanState>();

   /** Flag: true while replaying historical events (suppresses side-effects) */
   private _isRehydrating = false;

   // ========================================
   // Accessors
   // ========================================

   get isRehydrating(): boolean {
      return this._isRehydrating;
   }

   /** Get the state for a correlation ID (or undefined if not found) */
   getState(correlationId: string): PlanState | undefined {
      return this.store.get(correlationId);
   }

   /** Get all active (non-completed) plans */
   getActivePlans(): PlanState[] {
      return [...this.store.values()].filter((s) => s.phase !== 'completed');
   }

   /** Total number of tracked plans */
   get size(): number {
      return this.store.size;
   }

   // ========================================
   // Rehydration Control
   // ========================================

   /** Enter rehydration mode — state updates will NOT trigger side-effects */
   startRehydration(): void {
      this._isRehydrating = true;
      console.log('🔄 StateManager: Entering rehydration mode');
   }

   /** Exit rehydration mode — state updates WILL trigger side-effects */
   endRehydration(): void {
      this._isRehydrating = false;
      const active = this.getActivePlans();
      console.log(
         `✅ StateManager: Rehydration complete. ` +
            `${this.store.size} plans loaded, ${active.length} active.`
      );
   }

   // ========================================
   // State Transitions
   // ========================================

   /**
    * Handle a PlanGenerated event.
    * Initializes the plan state with all steps in 'pending' status.
    *
    * @returns true if this is a NEW plan, false if already exists (idempotent)
    */
   applyPlanGenerated(event: PlanGenerated): boolean {
      const { correlationId } = event;
      const { plan, conversationId, originalQuery } = event.payload;

      // Idempotency: skip if we already have this plan
      if (this.store.has(correlationId)) {
         console.log(
            `⏭️ StateManager: PlanGenerated [${correlationId}] already exists — skipping`
         );
         return false;
      }

      const planState: PlanState = {
         planId: plan.planId,
         correlationId,
         conversationId,
         originalQuery,
         phase: 'initialized',
         steps: plan.steps.map((step) => ({
            step,
            status: 'pending' as StepStatus,
         })),
         totalSteps: plan.totalSteps,
         createdAt: event.timestamp,
         updatedAt: event.timestamp,
      };

      this.store.set(correlationId, planState);

      console.log(
         `📋 StateManager: Initialized plan [${correlationId}] ` +
            `planId=${plan.planId} totalSteps=${plan.totalSteps}`
      );

      return true;
   }

   /**
    * Mark a step as 'dispatched' (command sent to worker).
    * Called AFTER producing ToolInvocationRequested.
    */
   markStepDispatched(correlationId: string, stepIndex: number): void {
      const state = this.store.get(correlationId);
      if (!state) return;

      const stepState = state.steps[stepIndex];
      if (!stepState) return;

      // Idempotency: only transition from 'pending'
      if (stepState.status !== 'pending') return;

      stepState.status = 'dispatched';
      stepState.dispatchedAt = Date.now();
      state.phase = 'executing';
      state.updatedAt = Date.now();
   }

   /**
    * Handle a ToolInvocationResulted event.
    * Updates the step state with the result.
    *
    * @returns The updated PlanState, or undefined if correlationId not found
    */
   applyToolResult(event: ToolInvocationResulted): PlanState | undefined {
      const { correlationId } = event;
      const { stepIndex, result, success, errorMessage, durationMs } =
         event.payload;

      const state = this.store.get(correlationId);
      if (!state) {
         console.warn(
            `⚠️ StateManager: ToolInvocationResulted for unknown plan [${correlationId}]`
         );
         return undefined;
      }

      const stepState = state.steps[stepIndex];
      if (!stepState) {
         console.warn(
            `⚠️ StateManager: ToolInvocationResulted for unknown step [${correlationId}] step=${stepIndex}`
         );
         return state;
      }

      // Idempotency: skip if step is already completed/failed
      if (stepState.status === 'completed' || stepState.status === 'failed') {
         console.log(
            `⏭️ StateManager: Step ${stepIndex} of [${correlationId}] already ${stepState.status} — skipping`
         );
         return state;
      }

      // Update step
      stepState.status = success ? 'completed' : 'failed';
      stepState.result = result;
      stepState.errorMessage = errorMessage;
      stepState.durationMs = durationMs;
      stepState.completedAt = event.timestamp;
      state.updatedAt = event.timestamp;

      console.log(
         `📝 StateManager: Step ${stepIndex} of [${correlationId}] → ${stepState.status} ` +
            `(${durationMs}ms)`
      );

      return state;
   }

   /**
    * Mark the entire plan as completed.
    * Called AFTER producing PlanCompleted.
    */
   markPlanCompleted(correlationId: string): void {
      const state = this.store.get(correlationId);
      if (!state) return;

      state.phase = 'completed';
      state.updatedAt = Date.now();

      console.log(
         `✅ StateManager: Plan [${correlationId}] marked as completed`
      );
   }

   // ========================================
   // Queries
   // ========================================

   /**
    * Get the next pending step that is ready to execute.
    *
    * A step is "ready" if:
    *   1. Its status is 'pending'
    *   2. All steps it depends on (via `dependsOn`) are 'completed'
    *
    * @returns The next step to dispatch, or undefined if none are ready
    */
   getNextReadyStep(correlationId: string): StepState | undefined {
      const state = this.store.get(correlationId);
      if (!state) return undefined;

      for (const stepState of state.steps) {
         if (stepState.status !== 'pending') continue;

         // Check dependencies
         const depsReady = stepState.step.dependsOn.every((depIdx) => {
            const depStep = state.steps[depIdx];
            return depStep && depStep.status === 'completed';
         });

         if (depsReady) return stepState;
      }

      return undefined;
   }

   /**
    * Check if ALL steps in the plan are done (completed or failed).
    */
   isPlanDone(correlationId: string): boolean {
      const state = this.store.get(correlationId);
      if (!state) return false;

      return state.steps.every(
         (s) => s.status === 'completed' || s.status === 'failed'
      );
   }

   /**
    * Get all completed step results for building PlanCompleted.
    */
   getCompletedResults(correlationId: string): Array<{
      stepIndex: number;
      toolName: string;
      result: string;
   }> {
      const state = this.store.get(correlationId);
      if (!state) return [];

      return state.steps
         .filter((s) => s.status === 'completed' && s.result !== undefined)
         .map((s) => ({
            stepIndex: s.step.stepIndex,
            toolName: s.step.toolName,
            result: s.result!,
         }));
   }

   /**
    * Calculate total duration from plan creation to now (or last step completion).
    */
   getTotalDuration(correlationId: string): number {
      const state = this.store.get(correlationId);
      if (!state) return 0;

      const lastCompletion = Math.max(
         ...state.steps.filter((s) => s.completedAt).map((s) => s.completedAt!),
         state.createdAt
      );

      return lastCompletion - state.createdAt;
   }

   // ========================================
   // Cleanup
   // ========================================

   /**
    * Remove completed plans older than maxAgeMs.
    * Prevents unbounded memory growth.
    */
   cleanupOldPlans(maxAgeMs: number = 30 * 60 * 1000): number {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;

      for (const [key, state] of this.store) {
         if (state.phase === 'completed' && state.updatedAt < cutoff) {
            this.store.delete(key);
            removed++;
         }
      }

      if (removed > 0) {
         console.log(`🧹 StateManager: Cleaned up ${removed} old plans`);
      }

      return removed;
   }
}
