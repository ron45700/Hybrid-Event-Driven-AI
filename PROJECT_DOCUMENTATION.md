# Project Documentation

## 1. Project Overview

This project is a **distributed Chatbot Application** built with a microservices architecture using **Apache Kafka** for event-driven communication. The system transforms user messages into classified intents, routes them to specialized worker applications, and returns responses—all through asynchronous Kafka messaging.

The application is structured as a **Monorepo** containing:

- **Frontend** (React + Vite)
- **Gateway Server** (Express)
- **Kafka Microservices** (7 services)

## Quick Start

```bash
# 1. Start Kafka
docker-compose up -d

# 2. Initialize Kafka topics (first time only)
bun run init-topics

# 3. Start all services (Client, Server, and 7 Microservices)
bun run start-services
```

Access the app at **http://localhost:5173**

---

## 2. Architecture and Structure

### System Architecture

```
┌──────────┐     ┌───────────────┐     ┌───────────────┐
│  React   │ ──▶ │ Express Server│ ──▶ │ RouterService │
│  Client  │     │ (Gateway)     │     │ (Classify)    │
└──────────┘     └───────────────┘     └───────┬───────┘
      ▲                 ▲                      │
      │                 │              user-input-events
      │                 │                      │
      │                 │                      ▼
      │                 │            ┌─────────────────┐
      │                 │            │  MemoryService  │
      │                 │            │ (History/State) │
      │                 │            └────────┬────────┘
      │                 │                     │
      │                 │          router-intents-enriched
      │                 │                     │
      │                 │    ┌────────────────┼────────────────┐
      │                 │    ▼                ▼                ▼
      │                 │  ┌────────┐  ┌────────────┐  ┌─────────────┐
      │                 │  │Workers │  │ WeatherApp │  │GeneralChat  │
      │                 │  │Math/Ex │  │            │  │App (OpenAI) │
      │                 │  └───┬────┘  └─────┬──────┘  └──────┬──────┘
      │                 │      └─────────────┼────────────────┘
      │                 │                    ▼
      │                 │              app-results
      │                 │                    │
      │    bot-responses│◀───────────────────┘
      │                 │            ┌────────────┐
      └─────────────────┘◀───────────│ Aggregator │
                                     └────────────┘
```

### Directory Structure

```text
my-app/
├── packages/
│   ├── client/                    # React Frontend (Vite + Tailwind)
│   │   └── src/components/chat/   # Chat UI components
│   │
│   ├── server/                    # Express Gateway Server
│   │   ├── controllers/
│   │   │   └── kafka-chat.controller.ts
│   │   ├── data/
│   │   │   └── history.json       # Conversation persistence
│   │   └── index.ts               # Server entry point
│   │
│   └── services/                  # Kafka Microservices
│       ├── shared/                # Shared utilities
│       │   ├── kafka-client.ts    # Kafka connection singleton
│       │   ├── kafka-topics.ts    # Topic constants & types
│       │   └── init-topics.ts     # Topic initialization script
│       │
│       ├── user-interface/        # Kafka ↔ Express bridge
│       ├── router-service/        # Intent classification (OpenAI)
│       ├── memory-service/        # History management
│       ├── aggregator/            # Response aggregation
│       │
│       └── workers/               # Specialized handlers
│           ├── math-app/          # Math calculations
│           ├── weather-app/       # Weather API (Open-Meteo)
│           ├── exchange-app/      # Currency rates
│           └── general-chat-app/  # OpenAI conversation
│
├── docker-compose.yml             # Kafka (Confluent) configuration
└── package.json                   # Workspace & scripts
```

---

## 3. Kafka Topics

| Topic                     | Producer      | Consumer                  | Purpose                      |
| ------------------------- | ------------- | ------------------------- | ---------------------------- |
| `user-input-events`       | UserInterface | RouterService             | User messages from UI        |
| `router-intents`          | RouterService | MemoryService             | Classified intents           |
| `router-intents-enriched` | MemoryService | All Workers               | Intents with history context |
| `app-results`             | All Workers   | MemoryService, Aggregator | Worker responses             |
| `bot-responses`           | Aggregator    | UserInterface             | Final responses to UI        |
| `user-control-events`     | UserInterface | MemoryService             | Control commands (reset)     |

---

## 4. Microservices

### UserInterface Service

- **Location**: `packages/services/user-interface/`
- **Purpose**: Bridges Express API with Kafka messaging
- **Produces to**: `user-input-events`, `user-control-events`
- **Consumes from**: `bot-responses`
- **Key Feature**: Correlation ID tracking for request/response matching

### RouterService

- **Location**: `packages/services/router-service/`
- **Purpose**: Classifies user intent using OpenAI
- **Produces to**: `router-intents`
- **Consumes from**: `user-input-events`
- **Intent Types**: `weather`, `math`, `currency`, `general`

### MemoryService

- **Location**: `packages/services/memory-service/`
- **Purpose**: Manages conversation history
- **Storage**: `packages/server/data/history.json` (Bun File API)
- **Features**:
   - Enriches intents with conversation history
   - Persists messages after each response
   - Handles reset commands

### Aggregator

- **Location**: `packages/services/aggregator/`
- **Purpose**: Collects worker results and publishes final responses
- **Produces to**: `bot-responses`
- **Consumes from**: `app-results`

### Worker Apps

| Worker             | Intent     | Logic                            |
| ------------------ | ---------- | -------------------------------- |
| **MathApp**        | `math`     | Safe expression evaluation       |
| **WeatherApp**     | `weather`  | Open-Meteo API integration       |
| **ExchangeApp**    | `currency` | Static USD exchange rates        |
| **GeneralChatApp** | `general`  | OpenAI with conversation history |

---

## 5. API Endpoints

### Chat Endpoint

- **Method**: `POST`
- **Path**: `/api/chat`
- **Request**:
   ```json
   {
      "prompt": "מה מזג האוויר בתל אביב?",
      "conversationId": "123e4567-e89b-12d3-a456-426614174000"
   }
   ```
- **Response**:
   ```json
   {
      "id": "msg_1234567890_abc",
      "message": "מזג האוויר ב-Tel Aviv: 22°C, שמיים בהירים"
   }
   ```

### Reset Endpoint

- **Method**: `DELETE`
- **Path**: `/api/chat/reset`
- **Purpose**: Clears conversation history

---

## 6. Technology Stack

| Component   | Technology                     |
| ----------- | ------------------------------ |
| Runtime     | Bun                            |
| Language    | TypeScript                     |
| Frontend    | React 19, Vite, Tailwind CSS 4 |
| Gateway     | Express.js                     |
| Messaging   | Apache Kafka (kafkajs)         |
| AI          | OpenAI API (gpt-4o-mini)       |
| Weather API | Open-Meteo                     |
| Validation  | Zod                            |
| Container   | Docker (Confluent Kafka)       |

---

## 7. Configuration

### Environment Variables

Create `.env` in `packages/server/`:

```env
OPENAI_API_KEY=sk-your-api-key
PORT=3000
KAFKA_BROKERS=localhost:9092
```

### Docker (Kafka)

Start Kafka:

```bash
docker-compose up -d
```

---

## 8. NPM Scripts

| Script       | Command                  | Description                            |
| ------------ | ------------------------ | -------------------------------------- |
| Start All    | `bun run start-services` | Runs Client + Server + 7 Microservices |
| Init Topics  | `bun run init-topics`    | Creates all Kafka topics               |
| Dev (legacy) | `bun run dev`            | Runs Client + Server only              |

---

## 9. Message Flow Example

When a user asks "כמה זה 5+5?":

1. **Client** → POST `/api/chat` → **Gateway**
2. **Gateway** → `user-input-events` → **RouterService**
3. **RouterService** classifies as `math` → `router-intents`
4. **MemoryService** enriches → `router-intents-enriched`
5. **MathApp** calculates `5+5=10` → `app-results`
6. **MemoryService** saves to history
7. **Aggregator** → `bot-responses`
8. **Gateway** receives via correlation ID → **Client**

Total latency: ~200-500ms
