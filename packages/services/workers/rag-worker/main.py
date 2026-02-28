"""
RAG Worker — Retrieval Augmented Generation via ChromaDB + sentence-transformers

Phase 5: Hybrid Search & Data Enrichment.
- On startup: ingests product data from /data/products using PRODUCT-LEVEL indexing.
  Each product is stored as one ChromaDB document with numeric metadata:
    - price  (float, USD)
    - rating (float, e.g. 4.7)
    - purpose (string, e.g. "gaming")
  Set env var FORCE_REINGEST=true to wipe and re-ingest the collection.
- On message: performs hybrid search — filters by metadata (price, rating, purpose)
  BEFORE semantic similarity scoring — returning top-3 matching products.
- Produces ToolInvocationResulted with retrieved context + metadata.
"""

import json
import time
import os
import re
import logging
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


def get_chroma_collection(force_reingest: bool = False):
    """Connect to ChromaDB and get or create the products collection."""
    client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)

    if force_reingest:
        logger.info("🔄 FORCE_REINGEST=true — deleting existing collection...")
        try:
            client.delete_collection(name=CHROMA_COLLECTION_NAME)
            logger.info("✅ Existing collection deleted")
        except Exception:
            logger.info("ℹ️  No existing collection to delete")

    collection = client.get_or_create_collection(
        name=CHROMA_COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )
    return collection


# ============================================
# Data Ingestion (Product-Level, with Numeric Metadata)
# ============================================


def parse_price(text: str) -> float | None:
    """
    Extract a USD price value from a line like 'Price: $1,299'.
    Returns a float (e.g. 1299.0) or None if not found.
    """
    match = re.search(r"\$([0-9,]+)", text)
    if match:
        return float(match.group(1).replace(",", ""))
    return None


def parse_rating(text: str) -> float | None:
    """
    Extract a numeric rating from a line like 'Rating: 4.7/5'.
    Returns a float (e.g. 4.7) or None if not found.
    """
    match = re.search(r"(\d+\.\d+)\s*/\s*5", text)
    if match:
        return float(match.group(1))
    return None


def parse_purpose(text: str) -> str | None:
    """
    Extract the purpose from a line like 'Purpose: Gaming'.
    Returns a lowercase string or None if not found.
    """
    match = re.search(r"Purpose:\s*(.+)", text, re.IGNORECASE)
    if match:
        return match.group(1).strip().lower()
    return None


def parse_products_from_file(filepath: str) -> list[dict]:
    """
    Parse a product text file into a list of product dicts.
    Each product block is delimited by '---'.
    Returns a list of:
      {
        "name": str,
        "text": str,      # full product text for embedding
        "price": float,
        "rating": float,
        "purpose": str,
        "source": str,    # filename
      }
    """
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    filename = os.path.basename(filepath)
    # Split by the '---' delimiter (ignoring the file header block)
    blocks = content.split("---")
    products = []

    for block in blocks:
        block = block.strip()
        if not block or block.startswith("Product Category:"):
            continue

        lines = block.strip().splitlines()
        name = None
        price = None
        rating = None
        purpose = None

        for line in lines:
            line = line.strip()
            if line.startswith("Product:"):
                name = line.replace("Product:", "").strip()
            elif line.startswith("Price:"):
                price = parse_price(line)
            elif line.startswith("Rating:"):
                rating = parse_rating(line)
            elif line.startswith("Purpose:"):
                purpose = parse_purpose(line)

        # Only include products with all required metadata
        if name and price is not None and rating is not None and purpose is not None:
            products.append(
                {
                    "name": name,
                    "text": block.strip(),
                    "price": price,
                    "rating": rating,
                    "purpose": purpose,
                    "source": filename,
                }
            )
        else:
            missing = []
            if not name:
                missing.append("name")
            if price is None:
                missing.append("price")
            if rating is None:
                missing.append("rating")
            if purpose is None:
                missing.append("purpose")
            logger.warning(f"⚠️  Skipping block — missing fields: {missing}")

    return products


def ingest_products(collection) -> int:
    """
    Read all .txt files from PRODUCTS_DATA_DIR, parse each product block,
    embed the full product text, and store with numeric metadata in ChromaDB.
    Skips ingestion if the collection already has data (unless FORCE_REINGEST=true).
    """
    existing_count = collection.count()
    if existing_count > 0:
        logger.info(
            f"⏭️  ChromaDB already has {existing_count} documents — skipping ingestion. "
            f"Set FORCE_REINGEST=true to re-ingest."
        )
        return existing_count

    import glob

    pattern = os.path.join(PRODUCTS_DATA_DIR, "*.txt")
    files = glob.glob(pattern)

    if not files:
        logger.warning(f"⚠️  No .txt files found in {PRODUCTS_DATA_DIR}")
        return 0

    all_texts: list[str] = []
    all_ids: list[str] = []
    all_metadatas: list[dict] = []

    for filepath in files:
        logger.info(f"📄 Parsing: {os.path.basename(filepath)}")
        products = parse_products_from_file(filepath)
        logger.info(f"   ✅ Found {len(products)} products")

        for product in products:
            # Use product name as a stable document ID
            safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", product["name"])
            doc_id = f"{product['source']}__{safe_name}"

            all_texts.append(product["text"])
            all_ids.append(doc_id)
            all_metadatas.append(
                {
                    "source": product["source"],
                    "name": product["name"],
                    "price": product["price"],      # float — supports $gte/$lte
                    "rating": product["rating"],    # float — supports $gte/$lte
                    "purpose": product["purpose"],  # string — supports $eq
                }
            )

    if not all_texts:
        logger.warning("⚠️  No products parsed from files")
        return 0

    # Embed all product descriptions at once
    logger.info(f"🧠 Embedding {len(all_texts)} product documents...")
    embeddings = embedding_model.encode(all_texts, show_progress_bar=True)

    # Store in ChromaDB with metadata
    collection.add(
        ids=all_ids,
        documents=all_texts,
        embeddings=embeddings.tolist(),
        metadatas=all_metadatas,
    )

    logger.info(f"✅ Ingested {len(all_texts)} products into ChromaDB")
    return len(all_texts)


# ============================================
# RAG Query (Hybrid: Metadata Filter + Semantic)
# ============================================


def build_where_clause(
    min_rating: float | None = None,
    max_price: float | None = None,
    purpose: str | None = None,
) -> dict | None:
    """
    Build a ChromaDB 'where' clause from optional filter parameters.
    Supports: min_rating ($gte), max_price ($lte), purpose ($eq).
    Returns None if no filters are provided.
    """
    clauses = []

    if min_rating is not None:
        clauses.append({"rating": {"$gte": float(min_rating)}})

    if max_price is not None:
        clauses.append({"price": {"$lte": float(max_price)}})

    if purpose is not None:
        clauses.append({"purpose": {"$eq": purpose.lower().strip()}})

    if not clauses:
        return None
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


def query_products(
    query: str,
    collection,
    top_k: int = TOP_K_RESULTS,
    min_rating: float | None = None,
    max_price: float | None = None,
    purpose: str | None = None,
) -> str:
    """
    Query ChromaDB for the most relevant products.
    Applies metadata filters (price, rating, purpose) BEFORE semantic scoring.
    Returns a formatted string with the top-K results.
    """
    query_embedding = embedding_model.encode([query])[0]

    where_clause = build_where_clause(min_rating, max_price, purpose)

    query_kwargs: dict = {
        "query_embeddings": [query_embedding.tolist()],
        "n_results": top_k,
        "include": ["documents", "metadatas", "distances"],
    }

    if where_clause:
        query_kwargs["where"] = where_clause
        logger.info(f"🔍 Applying metadata filter: {where_clause}")

    try:
        results = collection.query(**query_kwargs)
    except Exception as e:
        # If the where clause produces zero candidates ChromaDB can
        # throw an error — fall back to unfiltered semantic search.
        logger.warning(
            f"⚠️  Filtered query failed ({e}). Falling back to unfiltered search."
        )
        query_kwargs.pop("where", None)
        results = collection.query(**query_kwargs)

    documents = results.get("documents", [[]])[0]
    metadatas = results.get("metadatas", [[]])[0]
    distances = results.get("distances", [[]])[0]

    if not documents:
        return "No relevant products found matching your criteria."

    formatted_chunks = []
    for i, (doc, meta, dist) in enumerate(zip(documents, metadatas, distances)):
        similarity = round(1 - dist, 3)  # cosine distance → similarity score
        name = meta.get("name", "Unknown Product")
        price = meta.get("price", "N/A")
        rating = meta.get("rating", "N/A")
        purpose_val = meta.get("purpose", "N/A")

        # Build a clean, structured result for the Aggregator to synthesize
        formatted_chunks.append(
            f"[Result {i+1}] {name}\n"
            f"  • Price: ${price:,.0f} USD\n"
            f"  • Rating: {rating}/5\n"
            f"  • Purpose: {purpose_val.title()}\n"
            f"  • Match Score: {similarity:.3f}\n"
            f"  • Details: {doc}"
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

    Reads optional hybrid-search filters from toolInput:
      - query      (str,   required)  semantic search query
      - min_rating (float, optional)  e.g. 4.5 → only products rated >= 4.5
      - max_price  (float, optional)  e.g. 1000 → only products <= $1000
      - purpose    (str,   optional)  e.g. "gaming", "student", "programming"

    Queries ChromaDB with a metadata 'where' filter + semantic ranking,
    then produces ToolInvocationResulted → conversation-events.
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

    # Extract query + optional metadata filters
    query = tool_input.get("query", "")
    min_rating = tool_input.get("min_rating")
    max_price = tool_input.get("max_price")
    purpose = tool_input.get("purpose")

    logger.info(
        f"   Query: '{query}' | min_rating={min_rating} | "
        f"max_price={max_price} | purpose={purpose}"
    )

    start_time = time.time()

    try:
        result_text = query_products(
            query=query,
            collection=collection,
            min_rating=float(min_rating) if min_rating is not None else None,
            max_price=float(max_price) if max_price is not None else None,
            purpose=str(purpose) if purpose is not None else None,
        )
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
    force_reingest = os.getenv("FORCE_REINGEST", "false").lower() == "true"
    logger.info("🔌 Connecting to ChromaDB...")
    collection = get_chroma_collection(force_reingest=force_reingest)
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
