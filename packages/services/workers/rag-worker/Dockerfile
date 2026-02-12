FROM python:3.11-slim

WORKDIR /app

# Install dependencies first for better Docker cache
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create data directory (mount point for product files)
RUN mkdir -p /app/data/products

CMD ["python", "main.py"]
