// ============================================
// Chat Controller (Kafka Integration)
// Uses UserInterface service for Kafka messaging
// ============================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { userInterfaceService } from '../../services/user-interface/userInterface';

// Zod schema for validating incoming chat requests
const chatSchema = z.object({
   prompt: z
      .string()
      .trim()
      .min(1, 'prompt is required')
      .max(1000, 'prompt is too long (max 1000 characters)'),
   conversationId: z.string().uuid(),
});

// Generate unique ID for responses
function generateId(): string {
   return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Public interface
export const kafkaChatController = {
   /**
    * Handle incoming chat messages via Kafka
    * Publishes to user-input-events and waits for bot-responses
    */
   async handleChat(req: Request, res: Response) {
      // Validate request body
      const parseResult = chatSchema.safeParse(req.body);

      // ==> If validation fails
      if (!parseResult.success) {
         res.status(400).json(parseResult.error.format());
         return;
      }

      // ==> If validation succeeds
      try {
         const { prompt, conversationId } = parseResult.data;

         // Handle /reset command
         if (prompt.trim() === '/reset') {
            await userInterfaceService.sendResetCommand(conversationId);
            res.json({
               id: generateId(),
               message: 'השיחה אופסה בהצלחה. איך אפשר לעזור?',
            });
            return;
         }

         // Send message through Kafka and wait for response
         console.log(`📨 Controller: Sending message via Kafka...`);
         const response = await userInterfaceService.sendMessage(
            prompt,
            conversationId
         );

         // Send back the response to the client
         res.json({ id: generateId(), message: response });
      } catch (error) {
         console.error('Chat processing error:', error);

         // Handle timeout specifically
         if (error instanceof Error && error.message === 'Response timeout') {
            res.status(504).json({
               error: 'Request timed out. Please try again.',
            });
            return;
         }

         res.status(500).json({ error: 'Failed to process the request' });
      }
   },

   /**
    * Handle conversation reset via Kafka
    * Publishes to user-control-events
    */
   async handleReset(req: Request, res: Response) {
      try {
         const sessionId = req.body?.conversationId || 'default-session';
         await userInterfaceService.sendResetCommand(sessionId);
         res.json({ message: 'Conversation history has been reset.' });
      } catch (error) {
         console.error('Reset error:', error);
         res.status(500).json({ error: 'Failed to reset conversation' });
      }
   },
};
