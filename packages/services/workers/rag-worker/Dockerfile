# ============================================================
# RAG Worker — Dockerfile (Local Development)
# Simple single-stage build — NOT a production cloud image.
# ============================================================

FROM python:3.11-slim

# Set working directory inside the container
WORKDIR /app

# Install system-level build dependencies for native Python packages
# (sentence-transformers / hnswlib need a C compiler)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies first (layer-cached)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application source files
COPY config.py .
COPY main.py .

# The /app/data/products directory is populated at runtime
# via the Docker Compose volume mount from the host.
# No COPY needed here — changes to laptops.txt on the host
# are reflected in the container immediately.

# Default command — run the worker
CMD ["python", "main.py"]
