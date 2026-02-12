"""
RAG Worker — Retrieval Augmented Generation via ChromaDB + Kafka

Phase 1: Scaffold only — connects to Kafka, filters for toolName="rag",
and emits a placeholder ToolInvocationResulted event.
Actual RAG logic (ChromaDB query + LLM synthesis) will be added in Phase 4.
"""

import json
import time
import logging
import uuid
from kafka import KafkaConsumer, KafkaProducer
from kafka.errors import NoBrokersAvailable
from config import (
    KAFKA_BROKERS,
    KAFKA_GROUP_ID,
    TOPIC_TOOL_INVOCATION_REQUESTS,
    TOPIC_CONVERSATION_EVENTS,
    TOPIC_DEAD_LETTER_QUEUE,
    TOOL_NAME,
    SERVICE_NAME,
)

# ============================================
# Logging Setup
# ============================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger(SERVICE_NAME)

# ============================================
# Kafka Connection with Retry
# ============================================

MAX_RETRIES = 10
RETRY_DELAY_SECONDS = 3


def create_consumer() -> KafkaConsumer:
    """Create a Kafka consumer with retry logic."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            consumer = KafkaConsumer(
                TOPIC_TOOL_INVOCATION_REQUESTS,
                bootstrap_servers=KAFKA_BROKERS,
                group_id=KAFKA_GROUP_ID,
                auto_offset_reset="latest",
                value_deserializer=lambda v: json.loads(v.decode("utf-8")),
                key_deserializer=lambda k: k.decode("utf-8") if k else None,
            )
            logger.info("✅ Connected to Kafka (consumer)")
            return consumer
        except NoBrokersAvailable:
            logger.warning(
                f"⏳ Kafka not available, retrying ({attempt}/{MAX_RETRIES})..."
            )
            time.sleep(RETRY_DELAY_SECONDS)

    raise RuntimeError(f"Could not connect to Kafka after {MAX_RETRIES} retries")


def create_producer() -> KafkaProducer:
    """Create a Kafka producer with retry logic."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            producer = KafkaProducer(
                bootstrap_servers=KAFKA_BROKERS,
                value_serializer=lambda v: json.dumps(v).encode("utf-8"),
                key_serializer=lambda k: k.encode("utf-8") if k else None,
            )
            logger.info("✅ Connected to Kafka (producer)")
            return producer
        except NoBrokersAvailable:
            logger.warning(
                f"⏳ Kafka not available, retrying ({attempt}/{MAX_RETRIES})..."
            )
            time.sleep(RETRY_DELAY_SECONDS)

    raise RuntimeError(f"Could not connect to Kafka after {MAX_RETRIES} retries")


# ============================================
# Event Handlers
# ============================================


def handle_tool_invocation(event: dict, producer: KafkaProducer) -> None:
    """
    Process a ToolInvocationRequested event.
    Phase 1: Returns a placeholder response.
    Phase 4: Will query ChromaDB and synthesize with LLM.
    """
    payload = event.get("payload", {})
    tool_name = payload.get("toolName", "")

    # Only handle RAG requests
    if tool_name != TOOL_NAME:
        return

    correlation_id = event.get("correlationId", "")
    plan_id = payload.get("planId", "")
    step_index = payload.get("stepIndex", 0)
    tool_input = payload.get("toolInput", {})

    logger.info(f"📥 Processing RAG request [{correlation_id}] step={step_index}")
    logger.info(f"   Input: {json.dumps(tool_input, ensure_ascii=False)}")

    start_time = time.time()

    try:
        # =============================================
        # PHASE 4 TODO: Replace this placeholder with:
        # 1. Query ChromaDB for relevant documents
        # 2. Build context from retrieved chunks
        # 3. Send context + query to LLM for synthesis
        # =============================================
        query = tool_input.get("query", "")
        result_text = (
            f"[RAG Placeholder] Received query: '{query}'. "
            f"ChromaDB retrieval will be implemented in Phase 4."
        )
        success = True
        error_message = None

    except Exception as e:
        logger.error(f"❌ RAG processing failed: {e}")
        result_text = ""
        success = False
        error_message = str(e)

    duration_ms = int((time.time() - start_time) * 1000)

    # Emit ToolInvocationResulted → conversation-events
    result_event = {
        "eventType": "ToolInvocationResulted",
        "correlationId": correlation_id,
        "timestamp": int(time.time() * 1000),
        "payload": {
            "planId": plan_id,
            "stepIndex": step_index,
            "toolName": TOOL_NAME,
            "result": result_text,
            "success": success,
            "durationMs": duration_ms,
        },
    }

    if error_message:
        result_event["payload"]["errorMessage"] = error_message

    producer.send(TOPIC_CONVERSATION_EVENTS, value=result_event)
    producer.flush()

    logger.info(
        f"📤 Published ToolInvocationResulted [{correlation_id}] "
        f"success={success} duration={duration_ms}ms"
    )


def send_to_dead_letter(
    event: dict, error: str, producer: KafkaProducer
) -> None:
    """Send a failed event to the dead-letter-queue."""
    dead_letter = {
        "originalTopic": TOPIC_TOOL_INVOCATION_REQUESTS,
        "originalEvent": event,
        "errorMessage": error,
        "failedAt": int(time.time() * 1000),
        "serviceName": SERVICE_NAME,
        "retryCount": 0,
    }
    producer.send(TOPIC_DEAD_LETTER_QUEUE, value=dead_letter)
    producer.flush()
    logger.warning(f"📤 Sent to dead-letter-queue: {error}")


# ============================================
# Main Loop
# ============================================


def main() -> None:
    logger.info(f"🚀 {SERVICE_NAME}: Starting...")

    producer = create_producer()
    consumer = create_consumer()

    logger.info(
        f"✅ {SERVICE_NAME}: Running — listening on '{TOPIC_TOOL_INVOCATION_REQUESTS}'"
    )

    try:
        for message in consumer:
            event = message.value
            try:
                handle_tool_invocation(event, producer)
            except Exception as e:
                logger.error(f"❌ Unhandled error processing message: {e}")
                send_to_dead_letter(event, str(e), producer)
    except KeyboardInterrupt:
        logger.info(f"🛑 {SERVICE_NAME}: Shutting down...")
    finally:
        consumer.close()
        producer.close()
        logger.info(f"✅ {SERVICE_NAME}: Stopped")


if __name__ == "__main__":
    main()
