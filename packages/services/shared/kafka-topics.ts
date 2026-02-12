// ============================================
// Kafka Topics - Constants & Message Types
// ============================================

/**
 * Kafka Topic Names
 * Central definition of all topic names used across services
 */
export const TOPICS = {
   /** User messages from the UI */
   USER_INPUT: 'user_input_events',

   /** Classified intents from RouterService */
   ROUTER_INTENTS: 'router-intents',

   /** Enriched intents (with history) from MemoryService */
   ROUTER_INTENTS_ENRICHED: 'router-intents-enriched',

   /** Results from Worker apps */
   APP_RESULTS: 'app-results',

   /** Final responses to be sent to UI */
   BOT_RESPONSES: 'bot_output_events',

   /** Control events (reset, etc.) */
   USER_CONTROL: 'user-control-events',

   // ============================================
   // Stage 2: Advanced Event-Driven Topics
   // ============================================

   /** Router classification decision with confidence */
   ROUTER_DECISION: 'router_decision_events',

   /** Prompt sent TO the LLM */
   LLM_PROMPT: 'llm_prompt_requests',

   /** Raw LLM JSON output before validation */
   LLM_RESPONSE: 'llm_response_events',

   /** Validated function execution requests for Workers */
   FUNCTION_EXECUTION: 'function_execution_requests',

   /** Enriched execution requests (with history) from MemoryService */
   ENRICHED_EXECUTION: 'enriched_execution_requests',

   /** Guardrail violations (blocked content) */
   GUARDRAIL_VIOLATION: 'guardrail_violation_events',

   /** Chain-of-Thought math expressions */
   COT_MATH: 'cot_math_expression_events',

   /** System errors */
   ERROR_EVENTS: 'error_events',
} as const;

/** All topics as an array for initialization */
export const ALL_TOPICS = Object.values(TOPICS);

// ============================================
// Stage 3: Event-Sourced Architecture Topics
// These are the NEW topics for the state-machine flow.
// Old topics above are preserved for backward compatibility.
// ============================================

export const ES_TOPICS = {
   /** User commands (incoming queries from UI) */
   USER_COMMANDS: 'user-commands',

   /** Main event log — Single Source of Truth for conversation state */
   CONVERSATION_EVENTS: 'conversation-events',

   /** CQRS command channel — Orchestrator dispatches tool work here */
   TOOL_INVOCATION_REQUESTS: 'tool-invocation-requests',

   /** Failed messages that could not be processed by any service */
   DEAD_LETTER_QUEUE: 'dead-letter-queue',
} as const;

/** All event-sourced topics as an array for initialization */
export const ALL_ES_TOPICS = Object.values(ES_TOPICS);

// ============================================
// Message Type Definitions
// ============================================

/** Intent types matching the existing classification */
export type IntentType = 'weather' | 'math' | 'currency' | 'general';

/** Base message with correlation ID for tracking */
export interface BaseMessage {
   /** Unique message ID for correlation */
   correlationId: string;
   /** Timestamp of message creation */
   timestamp: number;
}

/** User input event from UI */
export interface UserInputMessage extends BaseMessage {
   /** User's message text */
   prompt: string;
   /** Session identifier */
   sessionId: string;
}

/** Classified intent from RouterService */
export interface RouterIntentMessage extends BaseMessage {
   /** Original user prompt */
   prompt: string;
   /** Classified intent type */
   intentType: IntentType;
   /** Extracted parameters for the worker */
   parameters: string;
   /** Classification confidence score (0.0-1.0) */
   confidence: number;
   /** Session identifier */
   sessionId: string;
   /** Conversation history (for GeneralChatApp) */
   history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
}

/** Result from a Worker app */
export interface AppResultMessage extends BaseMessage {
   /** The worker that processed this */
   source: IntentType;
   /** Original user prompt */
   prompt: string;
   /** Generated response */
   response: string;
   /** Session identifier */
   sessionId: string;
}

/** Final bot response to UI */
export interface BotResponseMessage extends BaseMessage {
   /** Final response to display */
   response: string;
   /** Session identifier */
   sessionId: string;
}

/** Control event (e.g., reset) */
export interface UserControlMessage extends BaseMessage {
   /** Type of control action */
   action: 'reset' | 'clear';
   /** Session identifier */
   sessionId: string;
}

// ============================================
// Stage 2: Advanced Message Types
// ============================================

/** Router decision event - classification result with confidence */
export interface RouterDecisionMessage extends BaseMessage {
   /** Original user prompt */
   prompt: string;
   /** Classified intent type */
   intentType: IntentType;
   /** Extracted parameters (JSON string) */
   parameters: string;
   /** Classification confidence score (0.0-1.0) */
   confidence: number;
   /** Session identifier */
   sessionId: string;
}

/** LLM prompt request - the exact prompt sent TO the LLM */
export interface LLMPromptMessage extends BaseMessage {
   /** The system prompt sent to LLM */
   systemPrompt: string;
   /** The user prompt sent to LLM */
   userPrompt: string;
   /** Session identifier */
   sessionId: string;
}

/** LLM raw response event */
export interface LLMResponseMessage extends BaseMessage {
   /** Raw JSON string from LLM */
   rawJson: string;
   /** Classified intent type */
   intentType: IntentType;
   /** Session identifier */
   sessionId: string;
}

/** Validated function execution request */
export interface FunctionExecutionRequest extends BaseMessage {
   /** Function/Worker to execute */
   functionName: IntentType;
   /** Validated parameters object */
   parameters: Record<string, unknown>;
   /** Session identifier */
   sessionId: string;
   /** Conversation history (for GeneralChatApp) */
   history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
}

/** Guardrail violation event */
export interface GuardrailViolationMessage extends BaseMessage {
   /** Original user prompt that was blocked */
   originalPrompt: string;
   /** Type of violation detected */
   violationType: 'politics' | 'malware' | 'inappropriate';
   /** Human-readable reason for blocking */
   blockedReason: string;
   /** Session identifier */
   sessionId: string;
}

/** Chain-of-Thought math expression */
export interface CoTMathMessage extends BaseMessage {
   /** Original word problem */
   originalProblem: string;
   /** Extracted mathematical expression */
   extractedExpression: string;
   /** LLM's reasoning steps */
   reasoning: string;
   /** Session identifier */
   sessionId: string;
}

/** System error event */
export interface ErrorEventMessage extends BaseMessage {
   /** Service that generated the error */
   source: string;
   /** Type of error */
   errorType: string;
   /** Error message details */
   errorMessage: string;
   /** Session identifier */
   sessionId: string;
}
