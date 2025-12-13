import type { Request, Response } from 'express';
import { chatService } from '../services/chat.service';
import { z } from 'zod';

// Zod schema for validating incoming chat requests
const chatSchama = z.object({
   prompt: z
      .string()
      .trim()
      .min(1, 'prompt is required')
      .max(1000, 'prompt is too long (max 1000 characters)'),
   conversationId: z.string().uuid(),
});

// Public interface
export const chatController = {
   async sendMessage(req: Request, res: Response) {
      // Validate request body
      const parseResult = chatSchama.safeParse(req.body);

      // ==> If validation fails
      if (!parseResult.success) {
         res.status(400).json(parseResult.error.format());
         return;
      }

      // ==> If validation succeeds
      try {
         const { prompt, conversationsId } = req.body;
         // send message to chat service
         const response = await chatService.sendMessage(
            prompt,
            conversationsId
         );

         // Send back the response to the client
         res.json({ message: response.message });
      } catch (error) {
         res.status(500).json({ error: 'failed to process the request' });
      }
   },
};
