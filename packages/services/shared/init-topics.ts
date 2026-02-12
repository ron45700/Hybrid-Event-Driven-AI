// ============================================
// Topic Initialization Script
// Creates all required Kafka topics using Admin API
// Supports both legacy and event-sourced topics
// ============================================

import { getAdmin } from './kafka-client';
import { ALL_TOPICS, ALL_ES_TOPICS } from './kafka-topics';

/** Topics requiring longer retention (event log / source of truth) */
const LONG_RETENTION_TOPICS = new Set(['conversation-events']);

/** Retention period for event-sourced event log (7 days in ms) */
const EVENT_LOG_RETENTION_MS = String(7 * 24 * 60 * 60 * 1000); // 604800000

/** Default retention period (1 day in ms) */
const DEFAULT_RETENTION_MS = String(24 * 60 * 60 * 1000); // 86400000

/**
 * Initialize all Kafka topics
 * Safe to run multiple times - skips existing topics
 */
async function initializeTopics(): Promise<void> {
   const admin = getAdmin();

   console.log('🔌 Connecting to Kafka...');
   await admin.connect();

   try {
      // Fetch existing topics
      const existingTopics = await admin.listTopics();
      console.log(
         `📋 Existing topics: ${existingTopics.length > 0 ? existingTopics.join(', ') : '(none)'}`
      );

      // Combine all topic lists
      const allTopics = [...ALL_TOPICS, ...ALL_ES_TOPICS];

      // Filter out topics that already exist
      const topicsToCreate = allTopics.filter(
         (topic) => !existingTopics.includes(topic)
      );

      if (topicsToCreate.length === 0) {
         console.log('✅ All topics already exist. Nothing to create.');
         return;
      }

      console.log(`📝 Creating topics: ${topicsToCreate.join(', ')}`);

      // Create topics with appropriate configuration
      await admin.createTopics({
         topics: topicsToCreate.map((topic) => ({
            topic,
            numPartitions: 3,
            replicationFactor: 1,
            configEntries: [
               {
                  name: 'retention.ms',
                  value: LONG_RETENTION_TOPICS.has(topic)
                     ? EVENT_LOG_RETENTION_MS
                     : DEFAULT_RETENTION_MS,
               },
            ],
         })),
         waitForLeaders: true,
      });

      console.log('✅ Topics created successfully!');

      // Verify creation
      const updatedTopics = await admin.listTopics();

      // Separate display: legacy vs event-sourced
      const legacyTopics = updatedTopics.filter((t) =>
         ALL_TOPICS.includes(t as any)
      );
      const esTopics = updatedTopics.filter((t) =>
         ALL_ES_TOPICS.includes(t as any)
      );

      console.log(
         `\n📋 Legacy topics (${legacyTopics.length}): ${legacyTopics.join(', ')}`
      );
      console.log(
         `📋 Event-Sourced topics (${esTopics.length}): ${esTopics.join(', ')}`
      );
   } catch (error) {
      console.error('❌ Failed to initialize topics:', error);
      throw error;
   } finally {
      await admin.disconnect();
      console.log('🔌 Disconnected from Kafka.');
   }
}

// Run if executed directly
initializeTopics()
   .then(() => {
      console.log('🎉 Topic initialization complete!');
      process.exit(0);
   })
   .catch((error) => {
      console.error('💥 Topic initialization failed:', error);
      process.exit(1);
   });
