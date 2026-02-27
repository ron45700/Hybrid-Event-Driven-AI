import { Kafka } from 'kafkajs';
import { randomUUID } from 'crypto';

const kafka = new Kafka({
   clientId: 'idempotency-tester',
   brokers: ['localhost:9092'],
});

const producer = kafka.producer();

async function runTest() {
   await producer.connect();
   console.log('🔌 Connected to Kafka.');

   // נייצר מזהה קבוע מראש כדי לדמות את "אותה בקשה"
   const fixedCorrelationId = randomUUID();
   const fixedConversationId = randomUUID();

   const eventPayload = {
      eventType: 'UserQueryReceived',
      correlationId: fixedCorrelationId,
      timestamp: Date.now(),
      payload: {
         userId: 'test-user',
         query: 'Is the system idempotent?',
         conversationId: fixedConversationId,
      },
   };

   console.log(
      `\n🚀 Sending FIRST event (CorrelationId: ${fixedCorrelationId})...`
   );
   await producer.send({
      topic: 'user-commands',
      messages: [{ value: JSON.stringify(eventPayload) }],
   });

   console.log(
      `🚀 Sending SECOND identical event (CorrelationId: ${fixedCorrelationId})...`
   );
   await producer.send({
      topic: 'user-commands',
      messages: [{ value: JSON.stringify(eventPayload) }],
   });

   console.log('\n✅ Both events sent identically within milliseconds!');
   await producer.disconnect();
}

runTest().catch(console.error);
