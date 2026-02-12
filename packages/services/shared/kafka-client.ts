// ============================================
// Kafka Client - Shared Singleton Instance
// ============================================

import { Kafka, type Consumer, type Producer, logLevel } from 'kafkajs';

/**
 * Kafka broker configuration
 * Uses environment variable or defaults to localhost:9092
 */
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(
   ','
);

/**
 * Shared Kafka instance
 * Singleton pattern - all services use the same instance
 */
export const kafka = new Kafka({
   clientId: process.env.KAFKA_CLIENT_ID || 'chatbot-service',
   brokers: KAFKA_BROKERS,
   logLevel: logLevel.WARN,
   retry: {
      initialRetryTime: 100,
      retries: 8,
   },
});

/**
 * Create a producer instance
 * Remember to connect before using: await producer.connect()
 */
export function createProducer(): Producer {
   return kafka.producer();
}

/**
 * Create a consumer instance with the specified group ID
 * Remember to connect before using: await consumer.connect()
 * @param groupId - Consumer group identifier
 */
export function createConsumer(groupId: string): Consumer {
   return kafka.consumer({ groupId });
}

/**
 * Get the admin client for topic management
 */
export function getAdmin() {
   return kafka.admin();
}
