"""
Configuration for the RAG Worker.
Reads environment variables with sensible defaults for local development.
"""

import os

# ============================================
# Kafka Configuration
# ============================================
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "localhost:9092")
KAFKA_GROUP_ID = "rag-worker-group"

# Topic names — must match ES_TOPICS in kafka-topics.ts
TOPIC_TOOL_INVOCATION_REQUESTS = "tool-invocation-requests"
TOPIC_CONVERSATION_EVENTS = "conversation-events"
TOPIC_DEAD_LETTER_QUEUE = "dead-letter-queue"

# ============================================
# ChromaDB Configuration
# ============================================
CHROMA_HOST = os.getenv("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.getenv("CHROMA_PORT", "8000"))
CHROMA_COLLECTION_NAME = "products"

# ============================================
# Embedding Model (HuggingFace / sentence-transformers)
# ============================================
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")

# ============================================
# Product Data Directory
# ============================================
PRODUCTS_DATA_DIR = os.getenv("PRODUCTS_DATA_DIR", "/app/data/products")

# ============================================
# RAG Settings
# ============================================
TOP_K_RESULTS = 3  # Number of chunks to retrieve

# ============================================
# Worker Identity
# ============================================
TOOL_NAME = "rag"
SERVICE_NAME = "rag-worker"
