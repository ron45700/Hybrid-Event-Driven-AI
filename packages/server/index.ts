import express from 'express';
import dotenv from 'dotenv';
import router from './routes';
import { kafkaChatController } from './controllers/kafka-chat.controller';
import { userInterfaceService } from '../services/user-interface/userInterface';

dotenv.config();

const app = express();
app.use(express.json());
app.use(router.router);

// Add DELETE endpoint for resetting conversation (via Kafka)
app.delete('/api/chat/reset', kafkaChatController.handleReset);

const PORT = process.env.PORT || 3000;

// Startup function
async function startServer() {
   // Start HTTP server immediately (don't wait for Kafka)
   app.listen(PORT, () => {
      console.log(`🚀 Server is running on http://localhost:${PORT}`);
   });

   // Initialize Kafka in background (non-blocking)
   try {
      console.log('🔌 Initializing Kafka UserInterface service...');
      await userInterfaceService.initialize();
      console.log('✅ Kafka UserInterface service initialized');
   } catch (error) {
      console.error('⚠️ Kafka initialization failed:', error);
      console.log('⚠️ Server running but Kafka features may not work');
   }
}

// Graceful shutdown
process.on('SIGINT', async () => {
   console.log('🔌 Shutting down...');
   await userInterfaceService.shutdown();
   process.exit(0);
});

// Initialize server
startServer();
