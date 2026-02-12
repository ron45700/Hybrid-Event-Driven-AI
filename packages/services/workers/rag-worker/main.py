"""
RAG Worker — Retrieval Augmented Generation via ChromaDB + sentence-transformers

Phase 4: Full implementation.
- On startup: ingests product text files from /data/products into ChromaDB
- On message: queries ChromaDB for top-K relevant chunks
- Produces ToolInvocationResulted with retrieved context
"""

import json
import time
import os
import logging
import glob
from kafka import KafkaConsumer, KafkaProducer
from kafka.errors import NoBrokersAvailable
from sentence_transformers import SentenceTransformer
import chromadb

from config import (
    KAFKA_BROKERS,
    KAFKA_GROUP_ID,
    TOPIC_TOOL_INVOCATION_REQUESTS,
    TOPIC_CONVERSATION_EVENTS,
    TOPIC_DEAD_LETTER_QUEUE,
    CHROMA_HOST,
    CHROMA_PORT,
    CHROMA_COLLECTION_NAME,
    EMBEDDING_MODEL,
    PRODUCTS_DATA_DIR,
    TOP_K_RESULTS,
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
# Embedding Model (loaded once at startup)
# ============================================
logger.info(f"📦 Loading embedding model: {EMBEDDING_MODEL}...")
embedding_model = SentenceTransformer(EMBEDDING_MODEL)
logger.info("✅ Embedding model loaded")

# ============================================
# ChromaDB Client + Collection
# ============================================


def get_chroma_collection():
    """Connect to ChromaDB and get or create the products collection."""
    client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
    collection = client.get_or_create_collection(
        name=CHROMA_COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )
    return collection


# ============================================
# Data Ingestion
# ============================================


def chunk_text(text: str, chunk_size: int = 300, overlap: int = 50) -> list[str]:
    """Split text into overlapping chunks by character count."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start += chunk_size - overlap
    return chunks


def ingest_products(collection) -> int:
    """
    Read all .txt files from PRODUCTS_DATA_DIR, chunk them,
    embed with sentence-transformers, and store in ChromaDB.
    Skips ingestion if the collection already has data.
    """
    existing_count = collection.count()
    if existing_count > 0:
        logger.info(
            f"⏭️ ChromaDB already has {existing_count} documents — skipping ingestion"
        )
        return existing_count

    # Find all text files
    pattern = os.path.join(PRODUCTS_DATA_DIR, "*.txt")
    files = glob.glob(pattern)

    if not files:
        logger.warning(f"⚠️ No .txt files found in {PRODUCTS_DATA_DIR}")
        return 0

    all_chunks: list[str] = []
    all_ids: list[str] = []
    all_metadatas: list[dict] = []

    for filepath in files:
        filename = os.path.basename(filepath)
        logger.info(f"📄 Reading: {filename}")

        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()

        chunks = chunk_text(content)
        for i, chunk in enumerate(chunks):
            doc_id = f"{filename}__chunk_{i}"
            all_chunks.append(chunk)
            all_ids.append(doc_id)
            all_metadatas.append({"source": filename, "chunk_index": i})

    if not all_chunks:
        logger.warning("⚠️ No chunks generated from files")
        return 0

    # Embed all chunks
    logger.info(f"🧠 Embedding {len(all_chunks)} chunks...")
    embeddings = embedding_model.encode(all_chunks, show_progress_bar=True)

    # Store in ChromaDB
    collection.add(
        ids=all_ids,
        documents=all_chunks,
        embeddings=embeddings.tolist(),
        metadatas=all_metadatas,
    )

    logger.info(f"✅ Ingested {len(all_chunks)} chunks into ChromaDB")
    return len(all_chunks)


# ============================================
# RAG Query
# ============================================


def query_products(query: str, collection, top_k: int = TOP_K_RESULTS) -> str:
    """
    Query ChromaDB for the most relevant product chunks.
    Returns a formatted string with the top-K results.
    """
    # Embed the query
    query_embedding = embedding_model.encode([query])[0]

    # Query ChromaDB
    results = collection.query(
        query_embeddings=[query_embedding.tolist()],
        n_results=top_k,
        include=["documents", "metadatas", "distances"],
    )

    documents = results.get("documents", [[]])[0]
    metadatas = results.get("metadatas", [[]])[0]
    distances = results.get("distances", [[]])[0]

    if not documents:
        return "No relevant products found."

    # Format results
    formatted_chunks = []
    for i, (doc, meta, dist) in enumerate(zip(documents, metadatas, distances)):
        similarity = round(1 - dist, 3)  # cosine distance → similarity
        source = meta.get("source", "unknown")
        formatted_chunks.append(
            f"[Result {i+1}] (source: {source}, similarity: {similarity})\n{doc}"
        )

    return "\n\n---\n\n".join(formatted_chunks)


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


def handle_tool_invocation(event: dict, producer: KafkaProducer, collection) -> None:
    """
    Process a ToolInvocationRequested event for RAG queries.
    Queries ChromaDB and returns the top-K relevant product chunks.
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

    query = tool_input.get("query", "")
    logger.info(f"   Query: {query}")

    start_time = time.time()

    try:
        result_text = query_products(query, collection)
        success = True
        error_message = None
    except Exception as e:
        logger.error(f"❌ RAG query failed: {e}")
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

    producer.send(
        TOPIC_CONVERSATION_EVENTS,
        key=correlation_id,
        value=result_event,
    )
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

    # 1. Connect to ChromaDB and ingest product data
    logger.info("🔌 Connecting to ChromaDB...")
    collection = get_chroma_collection()
    ingest_products(collection)

    # 2. Connect to Kafka
    producer = create_producer()
    consumer = create_consumer()

    logger.info(
        f"✅ {SERVICE_NAME}: Running — listening on '{TOPIC_TOOL_INVOCATION_REQUESTS}'"
    )

    try:
        for message in consumer:
            event = message.value
            try:
                handle_tool_invocation(event, producer, collection)
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
